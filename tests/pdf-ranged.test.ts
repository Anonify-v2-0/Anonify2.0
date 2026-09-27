import { describe, expect, it } from "vitest"

import { extractPdf } from "@/lib/documents/pdf/extract"
import { renderPagesForVision } from "@/lib/documents/pdf/page-images"
import type { OcrResult } from "@/lib/ocr"
import {
  bufferRangeSource,
  cachedRangeSource,
  type RangeSource,
} from "@/lib/storage/range-source"

import {
  makeImagePdfFixture,
  makePdfFixture,
  makeScannedPdfFixture,
} from "./fixtures"

/**
 * PDFs read by ranges.
 *
 * pdf.js is handed a range transport instead of the bytes, and asks for what
 * it parses. What it parses is the same file, so what comes out has to be the
 * same extraction and the same rendered pixels. The point of it is what it
 * does not read, and a read that fails underneath it has to fail the
 * extraction rather than leave pdf.js waiting for an answer.
 */

function counting(source: RangeSource) {
  let bytes = 0
  return {
    source: {
      size: source.size,
      range: async (start: number, end: number) => {
        bytes += end - start
        return source.range(start, end)
      },
    } satisfies RangeSource,
    read: () => bytes,
  }
}

/** Pages heavy enough that the file spans many of pdf.js's range chunks. */
function manyPages(count: number) {
  return makePdfFixture(
    Array.from({ length: count }, (_, page) => [
      { text: `Page ${page + 1}: John Smith, account 12-${page}` },
      ...Array.from({ length: 40 }, (_, line) => ({
        text: `Line ${line} of page ${page + 1}: ${"filler text ".repeat(6)}`,
        size: 8,
      })),
    ])
  )
}

const recognizer = async (): Promise<OcrResult> => ({
  words: [{ text: "Scanned", confidence: 90, bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } }],
  text: "Scanned",
  granularity: "word",
})

describe("extracting a PDF by ranges", () => {
  it("extracts exactly what the bytes extract", async () => {
    for (const bytes of [
      await makePdfFixture(),
      await manyPages(12),
      await makeImagePdfFixture(),
    ]) {
      const expected = await extractPdf("doc", bytes)
      expect(await extractPdf("doc", bufferRangeSource(bytes))).toEqual(expected)
      expect(
        await extractPdf("doc", cachedRangeSource(bufferRangeSource(bytes), 4096, 3))
      ).toEqual(expected)
    }
  })

  it("reads scanned pages with OCR exactly as the bytes do", async () => {
    const bytes = await makeScannedPdfFixture()
    const options = { ocr: true, recognize: recognizer }
    expect(await extractPdf("doc", bufferRangeSource(bytes), options)).toEqual(
      await extractPdf("doc", bytes, options)
    )
  })

  it("does not leave the bytes it was handed unreadable", async () => {
    const bytes = await makePdfFixture()
    const copy = new Uint8Array(bytes)
    const source = cachedRangeSource(bufferRangeSource(bytes), 1024, 64)
    await extractPdf("doc", source)
    // A transferred buffer is detached; the cache must still read.
    expect(Buffer.from(await source.range(0, bytes.byteLength)).equals(Buffer.from(copy))).toBe(true)
  })

  it("fails with the read that failed, rather than waiting on it forever", async () => {
    const bytes = await manyPages(300)
    expect(bytes.byteLength).toBeGreaterThan(4 * 64 * 1024)
    const inner = bufferRangeSource(bytes)
    let calls = 0
    const failing: RangeSource = {
      size: inner.size,
      range: async (start, end) => {
        calls += 1
        if (calls > 1) throw new Error("storage went away")
        return inner.range(start, end)
      },
    }

    await expect(extractPdf("doc", failing)).rejects.toThrow(/storage went away/)
  }, 20_000)
})

describe("rendering pages for the vision pass by ranges", () => {
  it("renders the same pixels, and reads less than the file to render one page", async () => {
    const bytes = await manyPages(1000)
    expect(bytes.byteLength).toBeGreaterThan(12 * 64 * 1024)
    const expected = await renderPagesForVision(bytes, [500], 0.5)
    const { source, read } = counting(bufferRangeSource(bytes))

    const rendered = await renderPagesForVision(source, [500], 0.5)

    expect(rendered.map((page) => page.page)).toEqual([500])
    expect(rendered[0].png.equals(expected[0].png)).toBe(true)
    expect(read()).toBeLessThan(bytes.byteLength / 2)
  }, 30_000)
})
