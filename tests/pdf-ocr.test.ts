import { describe, expect, it } from "vitest"

import { extractPdf } from "@/lib/documents/pdf/extract"
import { spansFromWords } from "@/lib/documents/pdf/ocr"
import type { OcrResult, OcrWord } from "@/lib/documents/image/extract"
import {
  makePdfFixture,
  makeScannedPdfFixture,
  makeScannedTextPdfFixture,
  SCANNED_TEXT,
} from "./fixtures"

/**
 * The recognizer is injected, so everything except tesseract itself is covered
 * here without a language-data download. The end-to-end pass against the real
 * engine is opt-in at the bottom of the file.
 */
function word(
  text: string,
  bbox: [number, number, number, number],
  confidence = 90
): OcrWord {
  return {
    text,
    confidence,
    bbox: { x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3] },
  }
}

function recognizerReturning(words: OcrWord[]) {
  return async (): Promise<OcrResult> => ({
    words,
    text: words.map((w) => w.text).join(" "),
  })
}

describe("mapping OCR words onto a page", () => {
  it("converts raster pixels back into PDF user space", () => {
    // Rendered at 2x, so a box at 200px is at 100 units.
    const result = spansFromWords(1, [word("Smith", [200, 100, 400, 160])], 2)

    expect(result.spans[0].boundingBox).toEqual({
      x: 100,
      y: 50,
      width: 100,
      height: 30,
    })
  })

  it("does not flip the y axis a second time", () => {
    // The raster comes from the same top-down viewport the extractor uses, so a
    // word near the top of the page must stay near the top.
    const result = spansFromWords(1, [word("Header", [0, 20, 100, 60])], 1)
    expect(result.spans[0].boundingBox!.y).toBe(20)
  })

  it("keeps span offsets aligned with the page text", () => {
    const result = spansFromWords(
      1,
      [word("Patient", [0, 0, 90, 30]), word("John", [100, 0, 160, 30])],
      1
    )

    expect(result.text).toContain("Patient")
    for (const span of result.spans) {
      expect(result.text.slice(span.start, span.end)).toBe(span.text)
    }
  })

  it("drops low-confidence noise", () => {
    const result = spansFromWords(
      1,
      [word("real", [0, 0, 40, 20], 95), word("|~", [50, 0, 60, 20], 12)],
      1
    )

    expect(result.words).toBe(1)
    expect(result.text.trim()).toBe("real")
  })

  it("drops whitespace-only words", () => {
    const result = spansFromWords(1, [word("   ", [0, 0, 40, 20])], 1)
    expect(result.words).toBe(0)
  })
})

describe("extracting a scanned PDF", () => {
  it("reads a flagged page and makes it reviewable", async () => {
    const bytes = await makeScannedPdfFixture()

    const before = await extractPdf("doc_1", bytes)
    expect(before.ocrPages).toEqual([1])
    expect(before.document.pages[0].spans).toHaveLength(0)

    const after = await extractPdf("doc_1", bytes, {
      ocr: true,
      recognize: recognizerReturning([
        word("Patient", [40, 40, 200, 100]),
        word("John", [220, 40, 320, 100]),
      ]),
    })

    const page = after.document.pages[0]
    expect(page.ocr).toBe(true)
    expect(page.text).toContain("Patient")
    expect(page.spans).toHaveLength(2)
    expect(page.spans[0].boundingBox).toBeDefined()

    // The page is no longer waiting to be read.
    expect(after.ocrPages).toEqual([])
  })

  it("leaves a genuinely blank page flagged rather than claiming it was read", async () => {
    const bytes = await makeScannedPdfFixture()

    const result = await extractPdf("doc_1", bytes, {
      ocr: true,
      recognize: recognizerReturning([]),
    })

    expect(result.ocrPages).toEqual([1])
    expect(result.document.pages[0].ocr).toBe(true)
  })

  it("does not touch pages that already had extractable text", async () => {
    const bytes = await makePdfFixture()

    const plain = await extractPdf("doc_1", bytes)
    const withOcr = await extractPdf("doc_1", bytes, {
      ocr: true,
      recognize: recognizerReturning([word("WRONG", [0, 0, 10, 10])]),
    })

    expect(withOcr.document.pages[0].text).toBe(plain.document.pages[0].text)
    expect(withOcr.document.pages[0].text).not.toContain("WRONG")
  })

  it("records which pages were read, for the reviewer's benefit", async () => {
    const bytes = await makeScannedPdfFixture()
    const result = await extractPdf("doc_1", bytes, {
      ocr: true,
      recognize: recognizerReturning([word("Scanned", [0, 0, 100, 40])]),
    })

    expect(result.document.metadata?.ocrPages).toEqual([1])
  })
})

/**
 * The real engine, against a PDF whose only content is a picture of text.
 * Opt-in because tesseract downloads language data on first use, which is not
 * something CI should depend on. Run with ANONIFY_OCR_TESTS=1.
 */
describe.runIf(process.env.ANONIFY_OCR_TESTS)("OCR end to end", () => {
  it("reads text that exists only as pixels", async () => {
    const bytes = await makeScannedTextPdfFixture()

    const plain = await extractPdf("doc_1", bytes)
    expect(plain.ocrPages).toEqual([1])

    const result = await extractPdf("doc_1", bytes, { ocr: true })
    const page = result.document.pages[0]

    expect(page.ocr).toBe(true)
    // OCR is imperfect; asserting on the distinctive surname is enough to show
    // that pixels became reviewable text.
    expect(page.text.toLowerCase()).toContain("smith")
    expect(page.spans.length).toBeGreaterThan(0)
    expect(SCANNED_TEXT.toLowerCase()).toContain("smith")
  }, 120_000)
})
