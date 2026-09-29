/**
 * The chunked envelope, sealed in the browser.
 *
 * An upload used to land in storage as the file itself and sit there until
 * ingest got round to it — the one place in Anonify where a document existed
 * unencrypted at rest, and not briefly: ingest only runs when the document is
 * admitted, and a large batch queues most of its uploads for minutes. So the
 * browser seals the file before it leaves the page, into exactly the v1 format
 * lib/storage/chunked.ts reads, and both upload paths carry and store only
 * ciphertext.
 *
 * The key is not the document's data key. That one is minted at ingest and
 * never leaves the server; this is a single-use **upload key** the server
 * minted at reservation, returned once, wrapped on the row, and destroyed when
 * ingest has re-sealed the bytes under the data key. See
 * lib/storage/upload-encryption.ts for its side of the exchange.
 *
 * The format rules are the server's, restated here because this file cannot
 * import that one (it is built on `node:crypto`), and held to it by a test
 * that seals here and opens there, at every size where a boundary could be
 * got wrong:
 *
 *   - header: `ANFY`, version 1, chunkShift, two zero bytes, 8-byte random
 *     nonce prefix;
 *   - chunk `i`: AES-256-GCM, nonce `prefix ‖ i as big-endian u32`, AAD
 *     `header ‖ logicalKey (UTF-8) ‖ finalFlag`, stored as `ciphertext ‖ tag`,
 *     which is what WebCrypto returns;
 *   - the final flag is set on the last chunk only, and an empty file is one
 *     empty final chunk.
 *
 * No `Buffer`, no `node:` import: this runs in the page.
 */

const MAGIC = [0x41, 0x4e, 0x46, 0x59] // "ANFY"
const VERSION = 0x01
export const WEB_HEADER_BYTES = 16
export const WEB_TAG_BYTES = 16
const NONCE_PREFIX_BYTES = 8
const KEY_BYTES = 32
const MIN_SHIFT = 4
const MAX_SHIFT = 24

/** What the reservation hands back when the upload is to be sealed. */
export type UploadEncryption = {
  format: "v1"
  /** The raw upload key, base64. Held only for the length of the transfer. */
  key: string
  chunkShift: number
}

function chunkCount(size: number, chunkSize: number): number {
  return size === 0 ? 1 : Math.ceil(size / chunkSize)
}

/** The sealed size of a file of `size` bytes, exactly as the server computes it. */
export function sealedUploadSize(size: number, chunkShift: number): number {
  const chunkSize = 2 ** chunkShift
  return WEB_HEADER_BYTES + size + chunkCount(size, chunkSize) * WEB_TAG_BYTES
}

export function decodeUploadKey(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const key = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    key[index] = binary.charCodeAt(index)
  }
  return key
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  )
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/**
 * Seals a file for upload, a chunk at a time.
 *
 * Each chunk is read with `slice()` and encrypted before the next is read, so
 * the plaintext is never copied whole; the ciphertext is collected into a
 * `Blob`, which is what both transports send and which the browser is free to
 * back with disk. `onProgress` reports the fraction sealed, for a progress bar
 * that covers sealing as well as sending.
 */
export async function sealFileForUpload(input: {
  file: Blob
  key: Uint8Array<ArrayBuffer>
  logicalKey: string
  chunkShift: number
  onProgress?: (fraction: number) => void
  /** For tests; the page uses its own. */
  subtle?: SubtleCrypto
  random?: (bytes: Uint8Array<ArrayBuffer>) => void
}): Promise<Blob> {
  const { file, key, logicalKey, chunkShift } = input
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("Upload key must be 32 bytes")
  }
  if (
    !Number.isInteger(chunkShift) ||
    chunkShift < MIN_SHIFT ||
    chunkShift > MAX_SHIFT
  ) {
    throw new Error(`Unsupported chunk size 2^${chunkShift}`)
  }

  const subtle = input.subtle ?? globalThis.crypto.subtle
  const random =
    input.random ??
    ((bytes: Uint8Array<ArrayBuffer>) =>
      globalThis.crypto.getRandomValues(bytes))

  const header = new Uint8Array(WEB_HEADER_BYTES)
  header.set(MAGIC, 0)
  header[4] = VERSION
  header[5] = chunkShift
  const prefix = new Uint8Array(NONCE_PREFIX_BYTES)
  random(prefix)
  header.set(prefix, 8)

  // Not extractable: once imported, the key cannot be read back out of the
  // page's crypto state, only used.
  const cryptoKey = await subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  )
  const logical = new TextEncoder().encode(logicalKey)
  const chunkSize = 2 ** chunkShift
  const count = chunkCount(file.size, chunkSize)
  const parts: BlobPart[] = [header]

  for (let index = 0; index < count; index++) {
    const final = index === count - 1
    const start = index * chunkSize
    const plaintext = new Uint8Array(
      await file
        .slice(start, Math.min(start + chunkSize, file.size))
        .arrayBuffer()
    )

    const nonce = new Uint8Array(12)
    nonce.set(prefix, 0)
    new DataView(nonce.buffer).setUint32(8, index, false)

    const sealed = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: concat(
          header,
          logical,
          new Uint8Array([final ? 1 : 0])
        ),
        tagLength: 128,
      },
      cryptoKey,
      plaintext
    )
    parts.push(sealed)
    input.onProgress?.((index + 1) / count)
  }

  return new Blob(parts, { type: "application/octet-stream" })
}
