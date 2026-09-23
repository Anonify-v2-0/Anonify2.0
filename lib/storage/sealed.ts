import { Readable } from "node:stream"

import {
  getObject,
  getObjectRange,
  getObjectStream,
  objectSize,
  putObject,
  putObjectStream,
  type StoredObject,
} from "@/lib/storage/blob"
import {
  ChunkOpener,
  ChunkSealer,
  HEADER_BYTES,
  openChunked,
  openChunkedRange,
  parseHeader,
  plaintextSizeOf,
  sealChunked,
  sealedRangeFor,
} from "@/lib/storage/chunked"
import {
  newDataKey,
  openWithKey,
  sealWithKey,
  withDataKey,
} from "@/lib/storage/encryption"
import {
  chain,
  collect,
  toReadable,
  type ByteSource,
} from "@/lib/storage/streams"
import { chunkShift, streamingLimits } from "@/lib/storage/streaming"

/**
 * Sealed objects, whichever envelope they were written in.
 *
 * Two envelopes exist. `v0` is the original — one AES-256-GCM pass over the
 * whole object, `iv || tag || ciphertext` — and every object written before
 * the chunked format arrived is in it. `v1` is the chunked format in
 * lib/storage/chunked.ts. A document records which one its objects use in
 * `Document.encryptionFormat`, and every read dispatches on that record.
 *
 * Not on the bytes. A v0 object begins with a random IV, and a random IV can
 * begin with `ANFY` like anything else can, so sniffing for the v1 magic is
 * ambiguous in principle — and "in principle" is the only kind of guarantee a
 * decryption path should be built on.
 *
 * Everything a document owns — its source, its normalized model, its exports,
 * reports and vaults — is in the document's format. A document ingested
 * before this existed keeps writing v0 for its whole life, and ages out
 * through the ordinary retention sweep; nothing is backfilled.
 *
 * Every object is also bound to its **logical key** — `documents/:id/…`, the
 * path it was written under — which the v1 format puts in each chunk's AAD.
 * The caller supplies it on read as well, from the document and the artifact
 * it is reading, never from anything stored alongside the bytes. That is what
 * stops one object of a document being swapped for another: they share a
 * data key, and before this nothing but the database row said which was
 * which.
 */

export const ENCRYPTION_FORMATS = ["v0", "v1"] as const

export type EncryptionFormat = (typeof ENCRYPTION_FORMATS)[number]

/** What every newly ingested document is sealed with. */
export const CURRENT_ENCRYPTION_FORMAT: EncryptionFormat = "v1"

/**
 * The format a document's objects are in, from its recorded column.
 *
 * Null is the legacy whole-object envelope: the column did not exist when
 * those documents were written. Anything else unrecognised is refused rather
 * than guessed at.
 */
export function encryptionFormatOf(
  recorded: string | null | undefined
): EncryptionFormat {
  if (recorded === null || recorded === undefined || recorded === "v0") {
    return "v0"
  }
  if (recorded === "v1") return "v1"
  throw new Error(`Unknown encryption format "${recorded}"`)
}

/** What sealing or opening one document's objects needs. */
export type DocumentSeal = {
  /** The document's data key, wrapped under the master key. */
  wrappedKey: string
  format: EncryptionFormat
}

export function documentSeal(document: {
  encryptionKey: string | null
  encryptionFormat?: string | null
}): DocumentSeal {
  if (!document.encryptionKey) {
    throw new Error("Document has no encryption key")
  }
  return {
    wrappedKey: document.encryptionKey,
    format: encryptionFormatOf(document.encryptionFormat),
  }
}

/** A fresh key for a new document, in the current format. */
export function newDocumentSeal(): DocumentSeal {
  const { dataKey, wrappedKey } = newDataKey()
  // Only the wrapped form leaves: every seal and open unwraps its own copy.
  dataKey.fill(0)
  return { wrappedKey, format: CURRENT_ENCRYPTION_FORMAT }
}

// --- whole objects ------------------------------------------------------------

export async function sealBytes(
  plaintext: Uint8Array,
  logicalKey: string,
  seal: DocumentSeal
): Promise<Buffer> {
  return withDataKey(seal.wrappedKey, (key) =>
    seal.format === "v1"
      ? sealChunked(plaintext, key, logicalKey, chunkShift())
      : sealWithKey(plaintext, key)
  )
}

export async function openBytes(
  sealed: Uint8Array,
  logicalKey: string,
  seal: DocumentSeal
): Promise<Buffer> {
  return withDataKey(seal.wrappedKey, (key) =>
    seal.format === "v1"
      ? openChunked(sealed, key, logicalKey)
      : openWithKey(sealed, key)
  )
}

export async function putSealed(
  logicalKey: string,
  plaintext: Uint8Array,
  seal: DocumentSeal
): Promise<StoredObject> {
  return putObject(logicalKey, await sealBytes(plaintext, logicalKey, seal))
}

/**
 * Reads a whole sealed object back.
 *
 * For the formats that genuinely need every byte at once — a PDF for pdf.js,
 * an image for OCR — and for everything small. `storedKey` is the handle the
 * write returned; `logicalKey` is the path it was written under.
 */
export async function getSealed(
  storedKey: string,
  logicalKey: string,
  seal: DocumentSeal
): Promise<Buffer> {
  return openBytes(await getObject(storedKey), logicalKey, seal)
}

// --- streams --------------------------------------------------------------------

/**
 * Seals a stream as it is written.
 *
 * In v1 the plaintext never lands in one place: the sealer holds one chunk and
 * the driver holds what its upload needs. A v0 document has no way to do that
 * — its envelope is one pass over everything — so its stream is collected and
 * sealed whole, exactly as it always was.
 */
export async function putSealedStream(
  logicalKey: string,
  source: ByteSource | Readable,
  seal: DocumentSeal
): Promise<StoredObject> {
  if (seal.format === "v0") {
    const plaintext = await collect(source)
    return putSealed(logicalKey, plaintext, seal)
  }

  const limits = streamingLimits()
  const sealer = await withDataKey(
    seal.wrappedKey,
    (key) =>
      new ChunkSealer(key, logicalKey, chunkShift(limits), limits.chunkBytes)
  )
  const body = toReadable(source)

  try {
    return await putObjectStream(logicalKey, chain(body, sealer))
  } catch (error) {
    body.destroy()
    sealer.destroy()
    throw error
  }
}

/**
 * A sealed object as a stream of authenticated plaintext.
 *
 * Nothing is emitted from a chunk until its tag has verified, and a truncated
 * object fails the stream at its end rather than quietly ending early.
 */
export async function getSealedStream(
  storedKey: string,
  logicalKey: string,
  seal: DocumentSeal
): Promise<Readable> {
  if (seal.format === "v0") {
    const plaintext = await getSealed(storedKey, logicalKey, seal)
    return Readable.from([plaintext])
  }

  const limits = streamingLimits()
  const opener = await withDataKey(
    seal.wrappedKey,
    (key) => new ChunkOpener(key, logicalKey, limits.chunkBytes)
  )
  return chain(await getObjectStream(storedKey), opener)
}

// --- random access -------------------------------------------------------------

/** One sealed object, opened for reading however the caller needs it. */
export type SealedObject = {
  /** Plaintext size in bytes. */
  size: number
  /** Plaintext `[start, end)`, every chunk it touches authenticated. */
  range: (start: number, end: number) => Promise<Buffer>
  stream: () => Promise<Readable>
}

/**
 * Opens a sealed object for ranged and streamed reads.
 *
 * In v1 a range costs one ranged read of exactly the chunks that cover it,
 * which is what lets a mailbox hand out one message at a time instead of
 * holding the mailbox. A v0 object cannot be read in pieces at all — its one
 * tag covers everything — so it is opened once, held, and sliced. That is the
 * same memory it always took, and it keeps a thousand-message legacy mailbox
 * from being decrypted a thousand times.
 */
export async function openSealedObject(
  storedKey: string,
  logicalKey: string,
  seal: DocumentSeal
): Promise<SealedObject> {
  if (seal.format === "v0") {
    const plaintext = await getSealed(storedKey, logicalKey, seal)
    return {
      size: plaintext.byteLength,
      range: async (start, end) => {
        if (start < 0 || end > plaintext.byteLength || start > end) {
          throw new RangeError(
            `Range ${start}-${end} is outside an object of ${plaintext.byteLength} bytes`
          )
        }
        return plaintext.subarray(start, end)
      },
      stream: async () => Readable.from([plaintext]),
    }
  }

  const [sealedSize, headerBytes] = await Promise.all([
    objectSize(storedKey),
    getObjectRange(storedKey, 0, HEADER_BYTES),
  ])
  // Not yet authenticated; it is in the AAD of every chunk opened below, so a
  // header that was tampered with fails the first read rather than this one.
  const header = parseHeader(headerBytes)
  const size = plaintextSizeOf(sealedSize, header.chunkSize)

  return {
    size,
    range: async (start, end) => {
      if (start === end) {
        if (start < 0 || start > size) {
          throw new RangeError(
            `Range ${start}-${end} is outside an object of ${size} bytes`
          )
        }
        return Buffer.alloc(0)
      }
      const covering = sealedRangeFor(start, end, size, header.chunkSize)
      const sealed = await getObjectRange(
        storedKey,
        covering.start,
        covering.end
      )
      return withDataKey(seal.wrappedKey, (key) =>
        openChunkedRange({
          header,
          key,
          logicalKey,
          plaintextSize: size,
          start,
          end,
          sealed,
        })
      )
    },
    stream: () => getSealedStream(storedKey, logicalKey, seal),
  }
}
