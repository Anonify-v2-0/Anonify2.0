import type { SealedObject } from "@/lib/storage/sealed"

/**
 * Random access to an object's plaintext, for the readers that need to jump
 * around in it rather than read it front to back: a zip's central directory is
 * at its end, a PDF's cross-reference table is at its end, and neither format
 * can be understood from its first byte onwards.
 */
export type RangeSource = {
  /** Plaintext size in bytes. */
  readonly size: number
  /** Plaintext `[start, end)`. */
  range(start: number, end: number): Promise<Buffer>
}

/** A range source over bytes already in memory, for tests and small files. */
export function bufferRangeSource(bytes: Uint8Array): RangeSource {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    size: buffer.byteLength,
    async range(start, end) {
      if (start < 0 || end > buffer.byteLength || start > end) {
        throw new RangeError(
          `Range ${start}-${end} is outside an object of ${buffer.byteLength} bytes`
        )
      }
      return buffer.subarray(start, end)
    },
  }
}

/**
 * A sealed object read in whole chunks, the last few of them kept.
 *
 * Every ranged read of a sealed object fetches and authenticates the chunks
 * that cover it, so fifty small reads inside one megabyte — the parts of a
 * Word document, the objects on a PDF page — would otherwise fetch and open
 * that megabyte fifty times. Reads here are widened to chunk boundaries and
 * the chunks kept, least recently used first out, so the cost is one fetch per
 * chunk touched while it stays warm.
 *
 * `keep` bounds what is held, and it is counted against the same streaming
 * budget everything else is: a handful of chunks, not the object.
 */
export function cachedRangeSource(
  object: Pick<SealedObject, "size" | "range">,
  chunkBytes: number,
  keep = 4
): RangeSource {
  const cache = new Map<number, Buffer>()

  async function chunk(index: number): Promise<Buffer> {
    const cached = cache.get(index)
    if (cached) {
      cache.delete(index)
      cache.set(index, cached)
      return cached
    }
    const start = index * chunkBytes
    const bytes = await object.range(start, Math.min(object.size, start + chunkBytes))
    cache.set(index, bytes)
    while (cache.size > keep) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return bytes
  }

  return {
    size: object.size,
    async range(start, end) {
      if (start < 0 || end > object.size || start > end) {
        throw new RangeError(
          `Range ${start}-${end} is outside an object of ${object.size} bytes`
        )
      }
      if (start === end) return Buffer.alloc(0)

      const first = Math.floor(start / chunkBytes)
      const last = Math.floor((end - 1) / chunkBytes)
      // A read wider than the cache would evict its own first chunks while
      // fetching its last; it goes straight to the object instead.
      if (last - first + 1 > keep) return object.range(start, end)

      const pieces: Buffer[] = []
      for (let index = first; index <= last; index++) {
        const bytes = await chunk(index)
        const from = index === first ? start - index * chunkBytes : 0
        const to = index === last ? end - index * chunkBytes : bytes.byteLength
        pieces.push(bytes.subarray(from, to))
      }
      return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces)
    },
  }
}
