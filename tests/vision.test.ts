import { beforeEach, describe, expect, it, vi } from "vitest"

import type { NormalizedDocument } from "@/types/document"

/**
 * The vision pass, and specifically where its answers land.
 *
 * The model returns coordinates normalized to 0-1 with no idea which page it
 * was shown, so the mapping back onto a page is entirely ours. Getting it wrong
 * is the quiet kind of wrong: a box drawn on page one for a signature on page
 * seven looks like a working redaction and covers nothing.
 */

const runStructured = vi.fn()

vi.mock("@/lib/ai/gateway", () => ({
  runStructured: (...args: unknown[]) => runStructured(...args),
  aiConfigured: () => true,
}))

const { analyzeImageRegions } = await import("@/lib/ai/analyze")

function model(): NormalizedDocument {
  return {
    documentId: "doc_1",
    kind: "pdf",
    pages: [
      { number: 1, width: 612, height: 792, text: "one", spans: [] },
      { number: 2, width: 612, height: 792, text: "two", spans: [], images: true },
      { number: 3, width: 300, height: 400, text: "three", spans: [], images: true },
    ],
  }
}

const image = { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }

beforeEach(() => {
  runStructured.mockReset()
})

describe("vision regions", () => {
  it("scales normalized coordinates onto the page it was given", async () => {
    runStructured.mockResolvedValue({
      output: {
        regions: [
          {
            kind: "face",
            category: "face",
            confidence: 0.9,
            reason: "a face",
            x: 0.5,
            y: 0.25,
            width: 0.1,
            height: 0.2,
          },
        ],
      },
    })

    const [detection] = await analyzeImageRegions("doc_1", model(), image, 2)

    expect(detection.page).toBe(2)
    expect(detection.boundingBox).toEqual({
      x: 306,
      y: 198,
      width: 61.2,
      height: 158.4,
    })
  })

  it("uses that page's own dimensions, not the first page's", async () => {
    runStructured.mockResolvedValue({
      output: {
        regions: [
          {
            kind: "object",
            category: "signature",
            confidence: 0.8,
            reason: "a signature",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
      },
    })

    const [detection] = await analyzeImageRegions("doc_1", model(), image, 3)

    expect(detection.page).toBe(3)
    expect(detection.boundingBox).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 400,
    })
  })

  it("defaults to page one, which is what an uploaded image is", async () => {
    runStructured.mockResolvedValue({ output: { regions: [] } })

    await analyzeImageRegions("doc_1", model(), image)
    expect(runStructured).toHaveBeenCalledOnce()
  })

  it("returns nothing when the provider gives nothing", async () => {
    runStructured.mockResolvedValue({ output: null })

    expect(await analyzeImageRegions("doc_1", model(), image, 2)).toEqual([])
  })
})
