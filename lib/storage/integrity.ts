import { createHash, timingSafeEqual } from "node:crypto"
import { Transform, type TransformCallback } from "node:stream"

/**
 * SHA-256 is used here for integrity only. It is not, and must never be treated
 * as, encryption — see lib/storage/encryption.ts for the real thing.
 */
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex")
}

export function checksumMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "hex")
  const b = Buffer.from(actual, "hex")
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

export class ChecksumMismatchError extends Error {
  constructor() {
    super("The stored object failed its integrity check")
    this.name = "ChecksumMismatchError"
  }
}

/**
 * Passes bytes through and checks them against a recorded checksum before the
 * last of them leaves.
 *
 * A download used to be read whole, hashed, compared and only then served,
 * which is the one order that can promise nothing unverified is delivered —
 * and costs the whole file in memory, per download. Streamed, the hash is only
 * known at the end. So the most recent piece is held back until the hash is:
 * a match releases it and ends the stream, and a mismatch fails the stream
 * instead. What the recipient then holds is a download that broke off short,
 * never a complete file that did not match.
 */
export class ChecksumVerifier extends Transform {
  private readonly hash = createHash("sha256")
  private held: Buffer | null = null

  constructor(
    private readonly expected: string,
    private readonly onMismatch?: () => void
  ) {
    super()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.hash.update(chunk)
    const previous = this.held
    this.held = chunk
    callback(null, previous ?? undefined)
  }

  override _flush(callback: TransformCallback): void {
    if (!checksumMatches(this.expected, this.hash.digest("hex"))) {
      this.held = null
      this.onMismatch?.()
      callback(new ChecksumMismatchError())
      return
    }
    const last = this.held
    this.held = null
    callback(null, last ?? undefined)
  }
}

/** The SHA-256 and length of a stream, read to its end and kept nowhere. */
export async function digestOf(
  source: AsyncIterable<Uint8Array>
): Promise<{ checksum: string; size: number }> {
  const hash = createHash("sha256")
  let size = 0
  for await (const piece of source) {
    hash.update(piece)
    size += piece.byteLength
  }
  return { checksum: hash.digest("hex"), size }
}
