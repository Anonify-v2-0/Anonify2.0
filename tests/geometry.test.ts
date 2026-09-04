import { describe, expect, it } from "vitest"

import { boxesForRedaction, boxForRange, padBox } from "@/lib/redaction/geometry"
import { newRedactionId } from "@/lib/documents/ids"
import type { TextSpan } from "@/types/document"
import type { Redaction } from "@/types/redaction"

function span(overrides: Partial<TextSpan> = {}): TextSpan {
  return {
    id: "s1",
    text: "John Smith",
    start: 0,
    end: 10,
    boundingBox: { x: 100, y: 50, width: 100, height: 12 },
    ...overrides,
  }
}

function redaction(overrides: Partial<Redaction> = {}): Redaction {
  return {
    id: newRedactionId(),
    documentId: "doc_1",
    type: "text",
    source: "ai",
    category: "person",
    status: "accepted",
    page: 1,
    ...overrides,
  }
}

describe("word-level geometry", () => {
  it("covers a proportional slice of the span", () => {
    // "Smith" is characters 5-10 of a ten-character span 100 wide.
    const box = boxForRange(span(), 5, 10)

    expect(box).toEqual({ x: 150, y: 50, width: 50, height: 12 })
  })

  it("covers the whole span when the redaction spans all of it", () => {
    expect(boxForRange(span(), 0, 10)).toEqual({
      x: 100,
      y: 50,
      width: 100,
      height: 12,
    })
  })

  it("never produces a zero-width box", () => {
    const box = boxForRange(span(), 3, 3)
    expect(box!.width).toBeGreaterThan(0)
  })
})

describe("block-level geometry", () => {
  const block = span({
    geometry: "block",
    text: "Patient John Smith\nAdmitted 4 March",
    end: 34,
    boundingBox: { x: 40, y: 40, width: 400, height: 90 },
  })

  it("covers the whole block rather than slicing it", () => {
    // A slice of a multi-line paragraph would be a rectangle on the wrong line.
    const box = boxForRange(block, 8, 18)

    expect(box).toEqual(block.boundingBox)
  })

  it("covers the block wherever in it the value sits", () => {
    const early = boxForRange(block, 0, 7)
    const late = boxForRange(block, 27, 34)

    expect(early).toEqual(late)
    expect(early).toEqual(block.boundingBox)
  })

  it("over-redacts rather than mislocating", () => {
    const sliced = boxForRange(span({ ...block, geometry: "word" }), 8, 18)
    const whole = boxForRange(block, 8, 18)

    // The word-geometry answer is narrower — and, for a wrapped paragraph,
    // wrong. Block geometry deliberately gives up precision to stay correct.
    expect(sliced!.width).toBeLessThan(whole!.width)
  })
})

describe("boxes for a redaction", () => {
  it("uses a redaction's own geometry when it has some", () => {
    const boundingBox = { x: 1, y: 2, width: 3, height: 4 }
    const boxes = boxesForRedaction(
      { spans: [] },
      redaction({ type: "region", boundingBox })
    )

    expect(boxes).toEqual([boundingBox])
  })

  it("collects a box per span the redaction touches", () => {
    const page = {
      spans: [
        span({ id: "a", start: 0, end: 4, text: "John" }),
        span({
          id: "b",
          start: 5,
          end: 10,
          text: "Smith",
          boundingBox: { x: 220, y: 50, width: 60, height: 12 },
        }),
      ],
    }

    const boxes = boxesForRedaction(page, redaction({ start: 0, end: 10 }))
    expect(boxes).toHaveLength(2)
  })

  it("ignores spans the redaction does not reach", () => {
    const page = {
      spans: [
        span({ id: "a", start: 0, end: 4 }),
        span({ id: "b", start: 20, end: 30 }),
      ],
    }

    expect(boxesForRedaction(page, redaction({ start: 0, end: 4 }))).toHaveLength(
      1
    )
  })

  it("returns nothing for a redaction with neither geometry nor offsets", () => {
    expect(boxesForRedaction({ spans: [span()] }, redaction())).toEqual([])
  })
})

describe("padding", () => {
  it("grows the box on every side", () => {
    expect(padBox({ x: 10, y: 10, width: 100, height: 20 }, 2)).toEqual({
      x: 8,
      y: 8,
      width: 104,
      height: 24,
    })
  })
})
