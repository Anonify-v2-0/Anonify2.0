import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Transform, type TransformCallback } from "node:stream"

import { ByteQueue } from "@/lib/storage/streams"

/**
 * The chunked envelope: AES-256-GCM over fixed-size chunks.
 *
 * The original envelope (`sealWithKey` in lib/storage/encryption.ts) is one
 * GCM pass over the whole plaintext. GCM is CTR underneath, so a slice of it
 * could be *decrypted* — but it cannot be *authenticated* without every byte
 * of the ciphertext, and handing out plaintext before its tag has verified is
 * exactly what this project does not do. So that format forces every reader
 * and every writer to hold the whole object.
 *
 * This one seals each chunk as its own AEAD message. Every byte that comes out
 * has been authenticated, and in exchange:
 *
 *   - memory is bounded by the chunk size, not by the object;
 *   - chunk `i` sits at a closed-form offset, so a plaintext byte range maps
 *     to a computable run of chunks and can be served by a ranged read;
 *   - chunks can be opened independently of one another.
 *
 * ```
 * header   16 bytes, cleartext, bound into every chunk's AAD
 *   magic        4   "ANFY"
 *   version      1   0x01
 *   chunkShift   1   log2(chunkSize)
 *   reserved     2   zero
 *   noncePrefix  8   random, per object
 *
 * chunk i
 *   ciphertext   chunkSize bytes; the final chunk is shorter (>= 1),
 *                except for an empty object, which is one empty final chunk
 *   tag          16
 * ```
 *
 * The three ways a chunked AEAD usually goes wrong, and what closes each:
 *
 *   1. **truncation** — dropping trailing chunks leaves a prefix that
 *      authenticates chunk by chunk. The final chunk is sealed with a
 *      different AAD (`finalFlag = 1`), so no proper prefix of an object is a
 *      valid object.
 *   2. **reordering** — the chunk counter is the low 32 bits of the nonce.
 *   3. **splicing between objects** — the logical storage key is in the AAD,
 *      so a chunk of `report.json.bin` does not open as `source.bin` even
 *      though both are sealed under the same per-document data key.
 *
 * Nonces are derived from the counter rather than drawn at random per chunk:
 * random 96-bit nonces walk towards the birthday bound over a large object,
 * and a derived one cannot repeat inside an object. Objects are write-once,
 * so a `(noncePrefix, counter)` pair never seals two different plaintexts.
 */

export const CHUNKED_MAGIC = Buffer.from("ANFY", "ascii")
export const CHUNKED_VERSION = 0x01
export const HEADER_BYTES = 16
export const TAG_BYTES = 16
const NONCE_PREFIX_BYTES = 8
const KEY_BYTES = 32

/**
 * Chunk sizes a sealed object may declare.
 *
 * The floor is small so the tests can exercise many chunk boundaries with a
 * few hundred bytes; production sizes are constrained further by
 * lib/storage/streaming.ts. The ceiling bounds what a reader will buffer
 * before it can authenticate anything.
 */
export const MIN_CHUNK_SHIFT = 4
export const MAX_CHUNK_SHIFT = 24

/** The chunk counter is 32 bits. Past that the nonce would repeat. */
const MAX_CHUNKS = 0x1_0000_0000

export class ChunkedFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChunkedFormatError"
  }
}

export type ChunkedHeader = {
  /** The header's 16 bytes exactly as stored; part of every chunk's AAD. */
  bytes: Buffer
  chunkShift: number
  chunkSize: number
  noncePrefix: Buffer
}

function assertShift(chunkShift: number): void {
  if (
    !Number.isInteger(chunkShift) ||
    chunkShift < MIN_CHUNK_SHIFT ||
    chunkShift > MAX_CHUNK_SHIFT
  ) {
    throw new ChunkedFormatError(`Unsupported chunk size 2^${chunkShift}`)
  }
}

export function createHeader(chunkShift: number): ChunkedHeader {
  assertShift(chunkShift)
  const bytes = Buffer.alloc(HEADER_BYTES)
  CHUNKED_MAGIC.copy(bytes, 0)
  bytes[4] = CHUNKED_VERSION
  bytes[5] = chunkShift
  // bytes 6-7 reserved, zero
  const noncePrefix = randomBytes(NONCE_PREFIX_BYTES)
  noncePrefix.copy(bytes, 8)
  return {
    bytes,
    chunkShift,
    chunkSize: 2 ** chunkShift,
    noncePrefix,
  }
}

/**
 * Reads a header back.
 *
 * Nothing here is trusted yet — the header is only authenticated when the
 * first chunk opens, because it is in that chunk's AAD. What this checks is
 * that it is a header this code knows how to read, and, crucially, it takes
 * the chunk size *from the object* rather than from configuration: the
 * configured size is only what new objects are sealed with, and changing it
 * must never make an existing object unreadable.
 */
export function parseHeader(bytes: Uint8Array): ChunkedHeader {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new ChunkedFormatError("Sealed object is too short to have a header")
  }
  const header = Buffer.from(bytes.subarray(0, HEADER_BYTES))
  if (!header.subarray(0, 4).equals(CHUNKED_MAGIC)) {
    throw new ChunkedFormatError("Sealed object is not in the chunked format")
  }
  if (header[4] !== CHUNKED_VERSION) {
    throw new ChunkedFormatError(`Unknown chunked format version ${header[4]}`)
  }
  if (header[6] !== 0 || header[7] !== 0) {
    throw new ChunkedFormatError("Chunked header has reserved bits set")
  }
  const chunkShift = header[5]
  assertShift(chunkShift)
  return {
    bytes: header,
    chunkShift,
    chunkSize: 2 ** chunkShift,
    noncePrefix: header.subarray(8, 16),
  }
}

// --- offset arithmetic -------------------------------------------------------

/** How many chunks an object of this plaintext size is sealed as. */
export function chunkCount(plaintextSize: number, chunkSize: number): number {
  return plaintextSize === 0 ? 1 : Math.ceil(plaintextSize / chunkSize)
}

/** The sealed size, exactly. The offset math is closed-form on purpose. */
export function sealedSizeOf(plaintextSize: number, chunkSize: number): number {
  return (
    HEADER_BYTES +
    plaintextSize +
    chunkCount(plaintextSize, chunkSize) * TAG_BYTES
  )
}

/**
 * The plaintext size of a sealed object, from its stored size alone.
 *
 * Throws for a size no sealer could have produced — a final chunk with
 * nothing in it after full ones, or a tail too short to hold a tag. Those are
 * truncations or extensions, and are refused here before any crypto runs.
 */
export function plaintextSizeOf(sealedSize: number, chunkSize: number): number {
  const body = sealedSize - HEADER_BYTES
  if (body < TAG_BYTES) {
    throw new ChunkedFormatError("Sealed object is truncated")
  }
  const count = Math.ceil(body / (chunkSize + TAG_BYTES))
  const plaintext = body - count * TAG_BYTES
  const last = plaintext - (count - 1) * chunkSize
  if (last < 0 || (count > 1 && last === 0)) {
    throw new ChunkedFormatError("Sealed object has an impossible length")
  }
  return plaintext
}

/** Where chunk `index` sits in the sealed object. */
export function chunkOffset(index: number, chunkSize: number): number {
  return HEADER_BYTES + index * (chunkSize + TAG_BYTES)
}

/** The sealed bytes covering plaintext `[start, end)`. */
export function sealedRangeFor(
  start: number,
  end: number,
  plaintextSize: number,
  chunkSize: number
): { first: number; last: number; start: number; end: number } {
  if (start < 0 || end > plaintextSize || start > end) {
    throw new RangeError(
      `Range ${start}-${end} is outside an object of ${plaintextSize} bytes`
    )
  }
  // An empty range still names a real chunk, so it can be read and checked
  // like any other; at the very end of an object that is the last one.
  const final = chunkCount(plaintextSize, chunkSize) - 1
  const first = Math.min(Math.floor(start / chunkSize), final)
  const last = end === start ? first : Math.floor((end - 1) / chunkSize)
  const lastPlaintext = Math.min(chunkSize, plaintextSize - last * chunkSize)
  return {
    first,
    last,
    start: chunkOffset(first, chunkSize),
    end: chunkOffset(last, chunkSize) + lastPlaintext + TAG_BYTES,
  }
}

// --- one chunk ----------------------------------------------------------------

function nonceFor(header: ChunkedHeader, index: number): Buffer {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) {
    // Fail closed rather than wrap: a wrapped counter reuses a nonce.
    throw new ChunkedFormatError("Chunk counter out of range")
  }
  const nonce = Buffer.alloc(12)
  header.noncePrefix.copy(nonce, 0)
  nonce.writeUInt32BE(index, 8)
  return nonce
}

function aadFor(
  header: ChunkedHeader,
  logicalKey: string,
  final: boolean
): Buffer {
  return Buffer.concat([
    header.bytes,
    Buffer.from(logicalKey, "utf8"),
    Buffer.from([final ? 1 : 0]),
  ])
}

function assertKey(key: Buffer): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new ChunkedFormatError("Data key must be 32 bytes")
  }
}

/** Seals one chunk, returning ciphertext || tag. */
export function sealChunk(
  key: Buffer,
  header: ChunkedHeader,
  logicalKey: string,
  index: number,
  final: boolean,
  plaintext: Uint8Array
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonceFor(header, index))
  cipher.setAAD(aadFor(header, logicalKey, final))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

/**
 * Opens one chunk. Throws unless its tag verifies, and returns nothing before
 * that: `final()` is what checks the tag, and the plaintext is only handed
 * back after it has returned.
 */
export function openChunk(
  key: Buffer,
  header: ChunkedHeader,
  logicalKey: string,
  index: number,
  final: boolean,
  sealed: Uint8Array
): Buffer {
  if (sealed.byteLength < TAG_BYTES) {
    throw new ChunkedFormatError("Chunk is too short to hold a tag")
  }
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength)
  const body = bytes.subarray(0, bytes.byteLength - TAG_BYTES)
  const tag = bytes.subarray(bytes.byteLength - TAG_BYTES)

  const decipher = createDecipheriv("aes-256-gcm", key, nonceFor(header, index))
  decipher.setAAD(aadFor(header, logicalKey, final))
  decipher.setAuthTag(tag)
  const opened = Buffer.concat([decipher.update(body), decipher.final()])
  return opened
}

// --- whole objects ------------------------------------------------------------

/** Seals a whole plaintext held in memory. */
export function sealChunked(
  plaintext: Uint8Array,
  key: Buffer,
  logicalKey: string,
  chunkShift: number
): Buffer {
  assertKey(key)
  const header = createHeader(chunkShift)
  const count = chunkCount(plaintext.byteLength, header.chunkSize)
  const pieces: Buffer[] = [header.bytes]

  for (let index = 0; index < count; index++) {
    const start = index * header.chunkSize
    const slice = plaintext.subarray(start, start + header.chunkSize)
    pieces.push(
      sealChunk(key, header, logicalKey, index, index === count - 1, slice)
    )
  }

  return Buffer.concat(pieces)
}

/** Opens a whole sealed object held in memory. */
export function openChunked(
  sealed: Uint8Array,
  key: Buffer,
  logicalKey: string
): Buffer {
  assertKey(key)
  const header = parseHeader(sealed)
  const plaintextSize = plaintextSizeOf(sealed.byteLength, header.chunkSize)
  const count = chunkCount(plaintextSize, header.chunkSize)
  const out = Buffer.allocUnsafe(plaintextSize)

  for (let index = 0; index < count; index++) {
    const start = chunkOffset(index, header.chunkSize)
    const length =
      Math.min(header.chunkSize, plaintextSize - index * header.chunkSize) +
      TAG_BYTES
    const opened = openChunk(
      key,
      header,
      logicalKey,
      index,
      index === count - 1,
      sealed.subarray(start, start + length)
    )
    opened.copy(out, index * header.chunkSize)
  }

  return out
}

/**
 * Opens plaintext `[start, end)` from the sealed bytes that cover it.
 *
 * `sealed` is exactly the run `sealedRangeFor` named — chunks `first` through
 * `last` — and every one of them is authenticated in full before any of its
 * bytes are returned, including the parts outside the requested range.
 */
export function openChunkedRange(input: {
  header: ChunkedHeader
  key: Buffer
  logicalKey: string
  plaintextSize: number
  start: number
  end: number
  sealed: Uint8Array
}): Buffer {
  const { header, key, logicalKey, plaintextSize, start, end, sealed } = input
  assertKey(key)
  const { chunkSize } = header
  const range = sealedRangeFor(start, end, plaintextSize, chunkSize)
  if (sealed.byteLength !== range.end - range.start) {
    throw new ChunkedFormatError("Ranged read returned the wrong length")
  }

  const last = chunkCount(plaintextSize, chunkSize) - 1
  const pieces: Buffer[] = []

  for (let index = range.first; index <= range.last; index++) {
    const offset = chunkOffset(index, chunkSize) - range.start
    const length =
      Math.min(chunkSize, plaintextSize - index * chunkSize) + TAG_BYTES
    pieces.push(
      openChunk(
        key,
        header,
        logicalKey,
        index,
        index === last,
        sealed.subarray(offset, offset + length)
      )
    )
  }

  const opened = Buffer.concat(pieces)
  const skip = start - range.first * chunkSize
  return opened.subarray(skip, skip + (end - start))
}

// --- streams ------------------------------------------------------------------

/**
 * Seals a byte stream chunk by chunk.
 *
 * A chunk is only sealed once it is known not to be the last one — which
 * means one more byte has arrived behind it — so the final chunk can carry
 * the final flag even when the plaintext is an exact multiple of the chunk
 * size. That is one chunk of lookahead, and it is the whole of the buffering.
 */
export class ChunkSealer extends Transform {
  private readonly key: Buffer
  private readonly header: ChunkedHeader
  private readonly queue = new ByteQueue()
  private index = 0
  private started = false

  constructor(
    key: Buffer,
    private readonly logicalKey: string,
    chunkShift: number,
    highWaterMark?: number
  ) {
    super({ highWaterMark })
    assertKey(key)
    // A copy, so the caller's key can be zeroed on its own schedule and this
    // one on ours.
    this.key = Buffer.from(key)
    this.header = createHeader(chunkShift)
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      this.start()
      this.queue.push(chunk)
      while (this.queue.length > this.header.chunkSize) {
        this.seal(this.queue.take(this.header.chunkSize), false)
      }
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.start()
      this.seal(this.queue.drain(), true)
      this.key.fill(0)
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _destroy(
    error: Error | null,
    callback: (error: Error | null) => void
  ): void {
    this.key.fill(0)
    callback(error)
  }

  private start(): void {
    if (this.started) return
    this.started = true
    this.push(this.header.bytes)
  }

  private seal(plaintext: Buffer, final: boolean): void {
    this.push(
      sealChunk(
        this.key,
        this.header,
        this.logicalKey,
        this.index,
        final,
        plaintext
      )
    )
    this.index += 1
  }
}

/**
 * Opens a sealed byte stream chunk by chunk.
 *
 * The mirror of the sealer, with the same one chunk of lookahead: a sealed
 * chunk is only known not to be the final one when more bytes follow it, so
 * it is held until they do. Plaintext is pushed only after its chunk's tag
 * verifies; a tampered chunk fails the stream at that chunk, and a truncated
 * object fails it at the end because its last chunk was not sealed as final.
 */
export class ChunkOpener extends Transform {
  private readonly key: Buffer
  private header: ChunkedHeader | null = null
  private readonly queue = new ByteQueue()
  private index = 0

  constructor(
    key: Buffer,
    private readonly logicalKey: string,
    highWaterMark?: number
  ) {
    super({ highWaterMark })
    assertKey(key)
    this.key = Buffer.from(key)
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      this.queue.push(chunk)
      if (!this.header) {
        if (this.queue.length < HEADER_BYTES) return callback()
        this.header = parseHeader(this.queue.take(HEADER_BYTES))
      }
      const sealedChunk = this.header.chunkSize + TAG_BYTES
      while (this.queue.length > sealedChunk) {
        this.open(this.queue.take(sealedChunk), false)
      }
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (!this.header) {
        throw new ChunkedFormatError(
          "Sealed object is too short to have a header"
        )
      }
      const rest = this.queue.drain()
      if (rest.byteLength < TAG_BYTES) {
        throw new ChunkedFormatError("Sealed object is truncated")
      }
      if (rest.byteLength === TAG_BYTES && this.index > 0) {
        // An empty final chunk after full ones is not something the sealer
        // writes, so it is not something the opener accepts.
        throw new ChunkedFormatError("Sealed object has an impossible length")
      }
      this.open(rest, true)
      this.key.fill(0)
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _destroy(
    error: Error | null,
    callback: (error: Error | null) => void
  ): void {
    this.key.fill(0)
    callback(error)
  }

  private open(sealed: Buffer, final: boolean): void {
    const header = this.header as ChunkedHeader
    const plaintext = openChunk(
      this.key,
      header,
      this.logicalKey,
      this.index,
      final,
      sealed
    )
    this.index += 1
    if (plaintext.byteLength > 0) this.push(plaintext)
  }
}
