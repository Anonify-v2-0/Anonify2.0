import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"

import { describe, expect, it } from "vitest"

import {
  CHUNKED_MAGIC,
  ChunkedFormatError,
  ChunkOpener,
  ChunkSealer,
  chunkOffset,
  HEADER_BYTES,
  openChunked,
  openChunkedRange,
  parseHeader,
  plaintextSizeOf,
  sealChunked,
  sealedRangeFor,
  sealedSizeOf,
  TAG_BYTES,
} from "@/lib/storage/chunked"
import { collect } from "@/lib/storage/streams"

/**
 * The chunked envelope, tested against the attacks it exists to close.
 *
 * Round-tripping is the easy half. The half that matters is what a chunked
 * AEAD usually gets wrong: a prefix that authenticates on its own, chunks
 * that can be put back in a different order, and a chunk of one object that
 * opens as part of another. Each of those has a test here that performs the
 * attack and expects it to fail.
 *
 * Chunks are tiny — sixteen bytes — so a few hundred bytes of plaintext cross
 * a lot of boundaries.
 */

const SHIFT = 4
const CHUNK = 2 ** SHIFT
const KEY = randomBytes(32)
const NAME = "documents/doc_1/source.bin"

function sealed(plaintext: Buffer, name = NAME): Buffer {
  return sealChunked(plaintext, KEY, name, SHIFT)
}

async function streamThrough(
  transform: ChunkSealer | ChunkOpener,
  input: Buffer,
  piece = 7
): Promise<Buffer> {
  const pieces: Buffer[] = []
  for (let at = 0; at < input.byteLength; at += piece) {
    pieces.push(input.subarray(at, at + piece))
  }
  return collect(Readable.from(pieces).pipe(transform))
}

describe("the chunked envelope", () => {
  it("round-trips every size across chunk boundaries", () => {
    for (let size = 0; size <= CHUNK * 4 + 1; size++) {
      const plaintext = randomBytes(size)
      const box = sealed(plaintext)
      expect(box.byteLength).toBe(sealedSizeOf(size, CHUNK))
      expect(plaintextSizeOf(box.byteLength, CHUNK)).toBe(size)
      expect(openChunked(box, KEY, NAME).equals(plaintext)).toBe(true)
    }
  })

  it("writes a header that says what it is and how it was cut", () => {
    const box = sealed(Buffer.from("hello"))
    expect(box.subarray(0, 4).equals(CHUNKED_MAGIC)).toBe(true)
    const header = parseHeader(box)
    expect(header.chunkSize).toBe(CHUNK)
    expect(header.bytes.subarray(6, 8).equals(Buffer.alloc(2))).toBe(true)
  })

  it("draws a fresh nonce prefix for every object", () => {
    const plaintext = Buffer.from("same bytes, twice")
    const a = sealed(plaintext)
    const b = sealed(plaintext)
    expect(a.subarray(8, 16).equals(b.subarray(8, 16))).toBe(false)
    expect(a.equals(b)).toBe(false)
  })

  it("keeps the plaintext out of the ciphertext", () => {
    const plaintext = Buffer.from("John Smith - john@example.com ".repeat(4))
    expect(sealed(plaintext).toString("latin1")).not.toContain(
      "john@example.com"
    )
  })

  it("seals an empty object as one empty final chunk", () => {
    const box = sealed(Buffer.alloc(0))
    expect(box.byteLength).toBe(HEADER_BYTES + TAG_BYTES)
    expect(openChunked(box, KEY, NAME).byteLength).toBe(0)
  })

  it("reads the chunk size from the object, not from anything configured", () => {
    const plaintext = randomBytes(300)
    // Sealed at two different sizes; opened by code that is told neither.
    for (const shift of [4, 6, 9]) {
      const box = sealChunked(plaintext, KEY, NAME, shift)
      expect(openChunked(box, KEY, NAME).equals(plaintext)).toBe(true)
    }
  })

  describe("the attacks", () => {
    const plaintext = randomBytes(CHUNK * 5 + 3)
    const box = sealed(plaintext)

    it("refuses a truncation at a chunk boundary", () => {
      // Dropping the last chunk leaves full chunks that each authenticate —
      // but none of them was sealed as the final one.
      const truncated = box.subarray(0, chunkOffset(5, CHUNK))
      expect(() => openChunked(truncated, KEY, NAME)).toThrow()
    })

    it("refuses every truncation, wherever it falls", () => {
      for (let length = 0; length < box.byteLength; length++) {
        expect(() => openChunked(box.subarray(0, length), KEY, NAME)).toThrow()
      }
    })

    it("refuses two chunks swapped", () => {
      const swapped = Buffer.from(box)
      const first = chunkOffset(1, CHUNK)
      const second = chunkOffset(2, CHUNK)
      const length = CHUNK + TAG_BYTES
      box.copy(swapped, first, second, second + length)
      box.copy(swapped, second, first, first + length)
      expect(() => openChunked(swapped, KEY, NAME)).toThrow()
    })

    it("refuses a chunk spliced in from another object under the same key", () => {
      // The report and the source share a data key. Before, nothing but the
      // database row said which blob was which.
      const other = sealed(
        randomBytes(plaintext.byteLength),
        "documents/doc_1/report.x.json.bin"
      )
      const spliced = Buffer.from(box)
      other.copy(
        spliced,
        chunkOffset(2, CHUNK),
        chunkOffset(2, CHUNK),
        chunkOffset(3, CHUNK)
      )
      expect(() => openChunked(spliced, KEY, NAME)).toThrow()
    })

    it("refuses a whole object opened under a different name", () => {
      expect(() =>
        openChunked(box, KEY, "documents/doc_1/normalized.json.bin")
      ).toThrow()
      expect(() =>
        openChunked(box, KEY, "documents/doc_2/source.bin")
      ).toThrow()
    })

    it("refuses a flipped bit anywhere, header included", () => {
      for (const at of [
        0,
        5,
        9,
        HEADER_BYTES,
        chunkOffset(3, CHUNK) + 2,
        box.byteLength - 1,
      ]) {
        const tampered = Buffer.from(box)
        tampered[at] ^= 0x01
        expect(() => openChunked(tampered, KEY, NAME)).toThrow()
      }
    })

    it("refuses the wrong key", () => {
      expect(() => openChunked(box, randomBytes(32), NAME)).toThrow()
    })

    it("refuses an object extended with an empty final chunk", () => {
      // Not something a sealer writes, so not something an opener accepts —
      // even before the crypto gets a say.
      const size = CHUNK * 2
      expect(() =>
        plaintextSizeOf(sealedSizeOf(size, CHUNK) + TAG_BYTES, CHUNK)
      ).toThrow(ChunkedFormatError)
    })

    it("refuses a header it does not know", () => {
      const wrongVersion = Buffer.from(box)
      wrongVersion[4] = 2
      expect(() => parseHeader(wrongVersion)).toThrow(ChunkedFormatError)

      const reserved = Buffer.from(box)
      reserved[7] = 1
      expect(() => parseHeader(reserved)).toThrow(ChunkedFormatError)

      const hugeChunks = Buffer.from(box)
      hugeChunks[5] = 40
      expect(() => parseHeader(hugeChunks)).toThrow(ChunkedFormatError)
    })
  })

  describe("ranges", () => {
    const plaintext = randomBytes(CHUNK * 6 + 5)
    const box = sealed(plaintext)
    const header = parseHeader(box)

    function readRange(start: number, end: number, source = box): Buffer {
      const covering = sealedRangeFor(start, end, plaintext.byteLength, CHUNK)
      return openChunkedRange({
        header,
        key: KEY,
        logicalKey: NAME,
        plaintextSize: plaintext.byteLength,
        start,
        end,
        sealed: source.subarray(covering.start, covering.end),
      })
    }

    it("reads any range, touching only the chunks that cover it", () => {
      for (let start = 0; start <= plaintext.byteLength; start += 3) {
        for (let end = start; end <= plaintext.byteLength; end += 5) {
          expect(
            readRange(start, end).equals(plaintext.subarray(start, end))
          ).toBe(true)
        }
      }
    })

    it("names exactly the chunks a range needs", () => {
      const covering = sealedRangeFor(
        CHUNK + 1,
        CHUNK * 2 + 1,
        plaintext.byteLength,
        CHUNK
      )
      expect(covering.first).toBe(1)
      expect(covering.last).toBe(2)
      expect(covering.start).toBe(chunkOffset(1, CHUNK))
      expect(covering.end).toBe(chunkOffset(3, CHUNK))
    })

    it("authenticates the chunks a range reads", () => {
      const tampered = Buffer.from(box)
      tampered[chunkOffset(2, CHUNK) + 1] ^= 0x01
      expect(() => readRange(CHUNK * 2, CHUNK * 2 + 4, tampered)).toThrow()
      // A range that does not touch the tampered chunk is still readable.
      expect(readRange(0, 4, tampered).equals(plaintext.subarray(0, 4))).toBe(
        true
      )
    })

    it("seals the last chunk as final, so a range ending there checks it", () => {
      const last = plaintext.byteLength
      expect(
        readRange(last - 2, last).equals(plaintext.subarray(last - 2))
      ).toBe(true)
    })
  })

  describe("streams", () => {
    it("seals as a stream exactly as it seals whole, apart from the nonce", async () => {
      for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 3, 250]) {
        const plaintext = randomBytes(size)
        const box = await streamThrough(
          new ChunkSealer(KEY, NAME, SHIFT),
          plaintext
        )
        expect(box.byteLength).toBe(sealedSizeOf(size, CHUNK))
        expect(openChunked(box, KEY, NAME).equals(plaintext)).toBe(true)
      }
    })

    it("opens as a stream what was sealed whole", async () => {
      for (const size of [0, 1, CHUNK, CHUNK * 2, 251]) {
        const plaintext = randomBytes(size)
        for (const piece of [1, 5, CHUNK + TAG_BYTES, 1000]) {
          const opened = await streamThrough(
            new ChunkOpener(KEY, NAME),
            sealed(plaintext),
            piece
          )
          expect(opened.equals(plaintext)).toBe(true)
        }
      }
    })

    it("fails a truncated stream at its end rather than ending quietly", async () => {
      const box = sealed(randomBytes(CHUNK * 4))
      const truncated = box.subarray(0, chunkOffset(3, CHUNK))
      await expect(
        streamThrough(new ChunkOpener(KEY, NAME), truncated)
      ).rejects.toThrow()
    })

    it("emits nothing from a chunk before its tag verifies", async () => {
      const plaintext = randomBytes(CHUNK * 4)
      const box = sealed(plaintext)
      box[chunkOffset(2, CHUNK) + 3] ^= 0x01

      const opener = new ChunkOpener(KEY, NAME)
      const received: Buffer[] = []
      opener.on("data", (piece: Buffer) => received.push(piece))
      const done = new Promise<void>((resolve, reject) => {
        opener.on("error", reject)
        opener.on("end", resolve)
      })
      opener.end(box)

      await expect(done).rejects.toThrow()
      // The two chunks before the tampered one verified and were released;
      // not a byte of the third was.
      expect(
        Buffer.concat(received).equals(plaintext.subarray(0, CHUNK * 2))
      ).toBe(true)
    })
  })
})
