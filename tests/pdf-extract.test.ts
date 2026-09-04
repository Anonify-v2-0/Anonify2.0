import { describe, expect, it } from "vitest"

import { extractPdf } from "@/lib/documents/pdf/extract"
import {
  makeImagePdfFixture,
  makePdfFixture,
  makeScannedPdfFixture,
  SENSITIVE,
} from "./fixtures"

describe("pdf extraction", () => {
  it("produces a normalized page per PDF page", async () => {
    const bytes = await makePdfFixture([
      [{ text: "Page one" }],
      [{ text: "Page two" }],
    ])

    const { document } = await extractPdf("doc_1", bytes)

    expect(document.kind).toBe("pdf")
    expect(document.pages).toHaveLength(2)
    expect(document.pages[0].number).toBe(1)
    expect(document.pages[0].width).toBeCloseTo(612, 0)
    expect(document.pages[0].height).toBeCloseTo(792, 0)
  })

  it("keeps span offsets aligned with the page text stream", async () => {
    const bytes = await makePdfFixture()
    const { document } = await extractPdf("doc_1", bytes)
    const page = document.pages[0]

    expect(page.text).toContain(SENSITIVE.person)
    expect(page.text).toContain(SENSITIVE.email)
    expect(page.spans.length).toBeGreaterThan(0)

    for (const span of page.spans) {
      expect(page.text.slice(span.start, span.end)).toBe(span.text)
    }
  })

  it("records a top-down bounding box for every span", async () => {
    const bytes = await makePdfFixture()
    const { document } = await extractPdf("doc_1", bytes)
    const page = document.pages[0]

    for (const span of page.spans) {
      expect(span.boundingBox).toBeDefined()
      const box = span.boundingBox!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeLessThan(page.height)
      expect(box.width).toBeGreaterThan(0)
      expect(box.height).toBeGreaterThan(0)
    }
  })

  it("orders spans down the page", async () => {
    const bytes = await makePdfFixture()
    const { document } = await extractPdf("doc_1", bytes)
    const [first, ...rest] = document.pages[0].spans
    const last = rest[rest.length - 1]

    expect(first.boundingBox!.y).toBeLessThan(last.boundingBox!.y)
  })

  it("carries font metadata through to spans", async () => {
    const bytes = await makePdfFixture()
    const { document } = await extractPdf("doc_1", bytes)
    const span = document.pages[0].spans[0]

    expect(span.style?.fontSize).toBeGreaterThan(0)
  })

  it("flags a page with no embedded text for OCR", async () => {
    const bytes = await makeScannedPdfFixture()
    const { document, ocrPages } = await extractPdf("doc_1", bytes)

    expect(ocrPages).toEqual([1])
    expect(document.pages[0].ocr).toBe(true)
  })
})

describe("pages that paint images", () => {
  it("flags only the pages that actually carry one", async () => {
    // This flag is what decides which pages get a vision pass. Marking a page
    // of pure text costs tokens for nothing; missing a page with a signature on
    // it means the signature is never proposed for redaction at all.
    const bytes = await makeImagePdfFixture()
    const { document } = await extractPdf("doc_1", bytes)

    expect(document.pages).toHaveLength(2)
    expect(document.pages[0].images).toBeUndefined()
    expect(document.pages[1].images).toBe(true)
  })

  it("does not mistake drawn vector shapes for an image", async () => {
    const bytes = await makeScannedPdfFixture()
    const { document } = await extractPdf("doc_1", bytes)

    expect(document.pages[0].images).toBeUndefined()
  })
})
