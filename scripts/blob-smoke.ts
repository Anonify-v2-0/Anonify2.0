import "dotenv/config"

import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"

import {
  openChunkedRange,
  parseHeader,
  plaintextSizeOf,
  sealChunked,
  sealedRangeFor,
} from "@/lib/storage/chunked"
import { vercelBlobDriver } from "@/lib/storage/drivers"

/**
 * The streaming half of the Vercel Blob driver, against a real Blob store.
 *
 * The driver asks for a byte range and slices the answer if it gets the whole
 * object back — correct either way, which is exactly why a store that ignored
 * ranges would go unnoticed: every per-message read of a mailbox, every page
 * of a model and every part of a workbook would quietly become a download of
 * the whole object. This asks directly and fails if the range is not honoured,
 * the check `pnpm smoke:storage` makes for S3.
 *
 *   BLOB_READ_WRITE_TOKEN=… pnpm smoke:blob
 *
 * It writes three objects of random bytes under `storage-smoke/` and deletes
 * them. Blob objects are public by URL; these hold nothing but noise.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not set; there is no Blob store to check")
  }

  const driver = vercelBlobDriver
  const written: string[] = []
  const name = () =>
    `storage-smoke/${Date.now()}-${randomBytes(6).toString("hex")}.bin`

  try {
    // 1. A streamed write, several chunks long.
    const large = randomBytes(3 * 1024 * 1024 + 123)
    async function* pieces(): AsyncGenerator<Buffer> {
      for (let at = 0; at < large.byteLength; at += 256 * 1024) {
        yield large.subarray(at, at + 256 * 1024)
      }
    }
    const stored = await driver.putStream(name(), Readable.from(pieces()))
    written.push(stored.key)
    assert(stored.size === large.byteLength, "putStream reported the wrong size")
    assert(
      (await driver.size(stored.key)) === large.byteLength,
      "size() disagrees with what was written"
    )

    const downloaded: Buffer[] = []
    for await (const piece of await driver.getStream(stored.key)) {
      downloaded.push(piece as Buffer)
    }
    assert(Buffer.concat(downloaded).equals(large), "getStream returned different bytes")

    // 2. The range, asked for directly: a 200 here is a store that ignores
    //    ranges, which the driver would hide.
    const start = 2 * 1024 * 1024 - 7
    const response = await fetch(stored.key, {
      cache: "no-store",
      headers: { range: `bytes=${start}-${start + 4095}` },
    })
    const body = Buffer.from(await response.arrayBuffer())
    assert(
      response.status === 206,
      `the store answered a Range request with HTTP ${response.status}, not 206`
    )
    assert(
      response.headers.get("content-range")?.startsWith(`bytes ${start}-${start + 4095}/`),
      `the store answered with Content-Range ${response.headers.get("content-range")}`
    )
    assert(body.byteLength === 4096, `a 4096-byte range came back as ${body.byteLength}`)
    assert(body.equals(large.subarray(start, start + 4096)), "the range held different bytes")

    const viaDriver = await driver.getRange(stored.key, start, start + 4096)
    assert(viaDriver.equals(large.subarray(start, start + 4096)), "getRange returned different bytes")

    // 3. A chunked-envelope object, opened one range at a time — the read a
    //    mailbox makes per message and the editor makes per page.
    const key = randomBytes(32)
    const logical = "documents/smoke/source.bin"
    const plaintext = randomBytes(3 * 1024 * 1024 + 11)
    const sealed = await driver.put(name(), sealChunked(plaintext, key, logical, 20))
    written.push(sealed.key)

    const header = parseHeader(await driver.getRange(sealed.key, 0, 16))
    const size = plaintextSizeOf(await driver.size(sealed.key), header.chunkSize)
    assert(size === plaintext.byteLength, "chunked size arithmetic disagrees with the store")

    const from = header.chunkSize - 100
    const to = 2 * header.chunkSize + 100
    const covering = sealedRangeFor(from, to, size, header.chunkSize)
    const opened = openChunkedRange({
      header,
      key,
      logicalKey: logical,
      plaintextSize: size,
      start: from,
      end: to,
      sealed: await driver.getRange(sealed.key, covering.start, covering.end),
    })
    assert(opened.equals(plaintext.subarray(from, to)), "chunked range opened to different bytes")
  } finally {
    for (const key of written) await driver.delete(key)
  }

  for (const key of written) {
    assert(!(await driver.exists(key)), "DELETE left the object behind")
  }

  console.log("Vercel Blob smoke passed: ranges are honoured with 206")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
