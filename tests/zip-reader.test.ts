import { unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { openZip, ZipFallback } from "@/lib/documents/ooxml/zip"
import { bufferRangeSource, cachedRangeSource } from "@/lib/storage/range-source"

import { makeDocxFixture, makeLongDocxFixture, makeXlsxFixture } from "./fixtures"
import { makePptxFixture } from "./pptx-fixtures"

/**
 * The ranged zip reader, held to the whole-file parser.
 *
 * Every entry it reads must be byte-for-byte what `unzipSync` inflates, for
 * archives written by the tools that actually write office files, whatever
 * the read window. And every archive where two zip parsers could disagree must
 * be refused rather than read one way, so the caller falls back to the parser
 * the rest of the pipeline uses.
 */

async function everyEntry(bytes: Uint8Array, window?: number) {
  const zip = await openZip(bufferRangeSource(bytes), window)
  const out: Record<string, Uint8Array> = {}
  for (const entry of zip.entries) {
    out[entry.name] = new Uint8Array(await zip.readAll(entry))
  }
  return out
}

async function fixtures(): Promise<Uint8Array[]> {
  const text = new TextEncoder().encode("John Smith ".repeat(40_000))
  return [
    await makeDocxFixture(),
    await makeLongDocxFixture(300),
    await makeXlsxFixture(),
    makePptxFixture(),
    zipSync({ "a.txt": text, "b/c.xml": text.subarray(0, 999) }, { level: 0 }),
    zipSync({ "a.txt": text, "empty.txt": new Uint8Array(0) }, { level: 9 }),
  ]
}

describe("reading a zip by ranges", () => {
  it("inflates every entry exactly as unzipSync does, at any window", { timeout: 60_000 }, async () => {
    for (const bytes of await fixtures()) {
      const expected = unzipSync(bytes)
      for (const window of [509, 65536, 1 << 20]) {
        expect(await everyEntry(bytes, window)).toEqual(expected)
      }
    }
  })

  it("reads through a cache of whole chunks without changing a byte", async () => {
    for (const bytes of await fixtures()) {
      const source = cachedRangeSource(bufferRangeSource(bytes), 64, 3)
      const zip = await openZip(source, 50)
      for (const entry of zip.entries) {
        expect(new Uint8Array(await zip.readAll(entry))).toEqual(
          unzipSync(bytes)[entry.name]
        )
      }
    }
  })

  it("stops reading when the reader stops", async () => {
    const bytes = zipSync({ "big.txt": new Uint8Array(4 << 20).fill(65) })
    let reads = 0
    const inner = bufferRangeSource(bytes)
    const zip = await openZip(
      { size: inner.size, range: (start, end) => (reads++, inner.range(start, end)) },
      1024
    )
    const before = reads
    for await (const piece of zip.read(zip.entries[0])) {
      expect(piece.byteLength).toBeGreaterThan(0)
      break
    }
    expect(reads - before).toBeLessThan(10)
  })
})

describe("archives two parsers could read differently", () => {
  const good = () => zipSync({ "word/document.xml": new TextEncoder().encode("<w/>") })

  async function refused(bytes: Uint8Array) {
    const zip = await openZip(bufferRangeSource(bytes)).catch((error) => error)
    if (zip instanceof Error) return zip
    try {
      for (const entry of zip.entries) await zip.readAll(entry)
    } catch (error) {
      return error
    }
    return null
  }

  function patch(bytes: Uint8Array, at: number, value: number[]): Uint8Array {
    const out = new Uint8Array(bytes)
    out.set(value, at)
    return out
  }

  function eocd(bytes: Uint8Array): number {
    const view = Buffer.from(bytes)
    for (let at = view.byteLength - 22; at >= 0; at--) {
      if (view.readUInt32LE(at) === 0x06054b50) return at
    }
    throw new Error("no end record")
  }

  it("refuses bytes in front of the first entry", async () => {
    const bytes = good()
    const shifted = new Uint8Array(bytes.byteLength + 7)
    shifted.set(bytes, 7)
    expect(await refused(shifted)).toBeInstanceOf(ZipFallback)
  })

  it("refuses bytes after the end record", async () => {
    const bytes = good()
    const padded = new Uint8Array(bytes.byteLength + 3)
    padded.set(bytes)
    expect(await refused(padded)).toBeInstanceOf(ZipFallback)
  })

  it("refuses a local name that is not the central one", async () => {
    const bytes = good()
    // The local header's name starts at 30; change its first letter.
    expect(await refused(patch(bytes, 30, [0x57]))).toBeInstanceOf(ZipFallback)
  })

  it("refuses a name outside ASCII", async () => {
    const bytes = zipSync({ "café.xml": new Uint8Array([1]) })
    expect(await refused(bytes)).toBeInstanceOf(ZipFallback)
  })

  it("refuses a duplicated name", async () => {
    const one = zipSync({ "a.xml": new Uint8Array([1]), "b.xml": new Uint8Array([2]) })
    // Rename b.xml to a.xml in both headers.
    const text = Buffer.from(one).toString("latin1").replaceAll("b.xml", "a.xml")
    expect(await refused(new Uint8Array(Buffer.from(text, "latin1")))).toBeInstanceOf(
      ZipFallback
    )
  })

  it("refuses an encrypted entry", async () => {
    const bytes = good()
    const central = Buffer.from(bytes).readUInt32LE(eocd(bytes) + 16)
    expect(await refused(patch(bytes, central + 8, [0x01, 0x00]))).toBeInstanceOf(
      ZipFallback
    )
  })

  it("refuses an entry that inflates to a size it did not declare", async () => {
    const bytes = good()
    const central = Buffer.from(bytes).readUInt32LE(eocd(bytes) + 16)
    expect(await refused(patch(bytes, central + 24, [0x03, 0x00, 0x00, 0x00]))).toBeInstanceOf(
      ZipFallback
    )
    expect(await refused(patch(bytes, central + 24, [0x09, 0x00, 0x00, 0x00]))).toBeInstanceOf(
      ZipFallback
    )
  })

  it("refuses corrupt compressed data", async () => {
    const bytes = zipSync({ "a.txt": new Uint8Array(5000).fill(66) }, { level: 6 })
    const data = 30 + "a.txt".length
    expect(await refused(patch(bytes, data, [0xff, 0xff, 0xff]))).toBeInstanceOf(ZipFallback)
  })

  it("refuses something that is not a zip at all", async () => {
    expect(await refused(new TextEncoder().encode("not a zip"))).toBeInstanceOf(ZipFallback)
  })
})
