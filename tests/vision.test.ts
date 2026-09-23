import { beforeEach, describe, expect, it, vi } from "vitest"

import type { NormalizedDocument } from "@/types/document"

/**
 * The vision pass, and specifically where its answers land.
 *
 * The model returns coordinates on a 0-1000 grid with no idea which page it
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
const { imageAnalysisSchema } = await import("@/lib/ai/schemas/detection")

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
  it("scales grid coordinates onto the page it was given", async () => {
    runStructured.mockResolvedValue({
      output: {
        regions: [
          {
            kind: "face",
            category: "face",
            confidence: 0.9,
            reason: "a face",
            x: 500,
            y: 250,
            width: 100,
            height: 200,
          },
        ],
      },
    })

    const { regions } = await analyzeImageRegions("doc_1", model(), image, 2)
    const [detection] = regions

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
            width: 1000,
            height: 1000,
          },
        ],
      },
    })

    const { regions } = await analyzeImageRegions("doc_1", model(), image, 3)
    const [detection] = regions

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

    expect(
      (await analyzeImageRegions("doc_1", model(), image, 2)).regions
    ).toEqual([])
  })

  it("cuts a long reason to length rather than losing the region", async () => {
    const region = {
      kind: "sensitive-text" as const,
      category: "person" as const,
      confidence: 0.7,
      reason: "A name, described at far greater length than asked. ".repeat(6),
      x: 100,
      y: 200,
      width: 300,
      height: 133,
    }
    // What Qwen3-VL sent: its grammar held the JSON's shape, not its lengths.
    expect(
      imageAnalysisSchema.safeParse({
        imageClass: "document",
        regions: [region],
      }).success
    ).toBe(true)
    runStructured.mockResolvedValue({ output: { regions: [region] } })

    const { regions } = await analyzeImageRegions("doc_1", model(), image, 2)

    expect(regions[0].reason).toHaveLength(200)
  })

  it("refuses 0-1 fractions instead of reading them as a speck in the corner", () => {
    // A model answering in the old convention: on the grid this box would be
    // under a thousandth of the page, placed confidently over nothing.
    const fractional = imageAnalysisSchema.safeParse({
      imageClass: "photograph",
      regions: [
        {
          kind: "face",
          category: "face",
          confidence: 0.9,
          reason: "a face",
          x: 0.4,
          y: 0.2,
          width: 0.3,
          height: 0.4,
        },
      ],
    })

    expect(fractional.success).toBe(false)
  })

  it("carries the reason back, so a refused pass is not read as an empty one", async () => {
    runStructured.mockResolvedValue({ output: null, skipped: "rate-limit" })

    const analysis = await analyzeImageRegions("doc_1", model(), image, 2)

    expect(analysis.regions).toEqual([])
    expect(analysis.skipped).toBe("rate-limit")
  })
})
