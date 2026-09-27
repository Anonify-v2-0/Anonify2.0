import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"

import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { buildArchive, streamArchive } from "@/lib/redaction/archive"
import {
  ChecksumMismatchError,
  ChecksumVerifier,
  digestOf,
  sha256,
} from "@/lib/storage/integrity"
import { chain, collect } from "@/lib/storage/streams"

/**
 * Downloads that are never whole in memory.
 *
 * A download used to be decrypted whole, hashed, and only then served; a batch
 * held every artifact and then the zip of them. Streamed, the checksum can
 * only be known at the end — so what has to hold is that a file which fails it
 * is never delivered complete, and that the streamed archive carries exactly
 * what the in-memory one did.
 */

function pieces(bytes: Buffer, size: number): Readable {
  const out: Buffer[] = []
  for (let at = 0; at < bytes.byteLength; at += size) {
    out.push(bytes.subarray(at, at + size))
  }
  return Readable.from(out, { objectMode: false })
}

describe("verifying a stream against its checksum", () => {
  const bytes = randomBytes(10_000)

  it("passes a matching stream through unchanged", async () => {
    for (const size of [1, 999, 10_000, 20_000]) {
      const out = await collect(chain(pieces(bytes, size), new ChecksumVerifier(sha256(bytes))))
      expect(out.equals(bytes)).toBe(true)
    }
  })

  it("fails a stream that does not match, before its last piece leaves", async () => {
    let reported = 0
    const verifier = chain(
      pieces(bytes, 1000),
      new ChecksumVerifier(sha256(Buffer.from("something else")), () => {
        reported += 1
      })
    )
    const received: Buffer[] = []
    await expect(
      (async () => {
        for await (const piece of verifier) received.push(piece)
      })()
    ).rejects.toBeInstanceOf(ChecksumMismatchError)

    expect(reported).toBe(1)
    // Never the whole file: at most everything before the withheld last
    // piece, and only as much as the reader took before the stream failed.
    const got = Buffer.concat(received)
    expect(got.byteLength).toBeLessThanOrEqual(9_000)
    expect(got.equals(bytes.subarray(0, got.byteLength))).toBe(true)
  })

  it("withholds everything from a file that fits in one piece", async () => {
    const received: Buffer[] = []
    const verifier = chain(pieces(bytes, 20_000), new ChecksumVerifier(sha256("x")))
    await expect(
      (async () => {
        for await (const piece of verifier) received.push(piece)
      })()
    ).rejects.toBeInstanceOf(ChecksumMismatchError)
    expect(received).toEqual([])
  })

  it("refuses an empty expected checksum rather than passing it", async () => {
    await expect(collect(chain(pieces(bytes, 100), new ChecksumVerifier("")))).rejects.toBeInstanceOf(
      ChecksumMismatchError
    )
  })

  it("digests a stream without keeping it", async () => {
    expect(await digestOf(pieces(bytes, 333))).toEqual({
      checksum: sha256(bytes),
      size: bytes.byteLength,
    })
  })
})

describe("the streamed batch archive", () => {
  const files = [
    { name: "invoice.pdf", bytes: new Uint8Array(randomBytes(300_000)) },
    { name: "invoice.pdf", bytes: new Uint8Array(Buffer.from("second invoice")) },
    { name: "invoice-redaction-report.json", bytes: new Uint8Array(Buffer.from("{}")) },
    { name: "empty.txt", bytes: new Uint8Array(0) },
  ]

  it("carries exactly the entries the in-memory archive carries", async () => {
    const streamed = await collect(streamArchive(files))
    expect(unzipSync(new Uint8Array(streamed))).toEqual(unzipSync(buildArchive(files)))
  })

  it("opens a streamed file only when the archive reaches it", async () => {
    const opened: string[] = []
    const entries = files.map((file) => ({
      name: file.name,
      open: async () => {
        opened.push(file.name)
        return pieces(Buffer.from(file.bytes), 4096)
      },
    }))
    const archive = streamArchive(entries)
    const first = await archive.next()

    expect(first.done).toBe(false)
    expect(opened.length).toBeLessThan(entries.length)

    const rest: Uint8Array[] = [first.value as Uint8Array]
    for await (const piece of archive) rest.push(piece)
    expect(unzipSync(new Uint8Array(Buffer.concat(rest)))).toEqual(
      unzipSync(buildArchive(files))
    )
  })

  it("fails the archive when a file fails while it streams", async () => {
    const entries = [
      {
        name: "tampered.pdf",
        open: async () =>
          chain(pieces(randomBytes(5000), 1000), new ChecksumVerifier(sha256("x"))),
      },
      { name: "after.txt", bytes: new Uint8Array(Buffer.from("never reached")) },
    ]
    await expect(
      (async () => {
        for await (const piece of streamArchive(entries)) void piece
      })()
    ).rejects.toBeInstanceOf(ChecksumMismatchError)
  })
})
