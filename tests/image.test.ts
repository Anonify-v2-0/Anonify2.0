import sharp from "sharp"
import { describe, expect, it } from "vitest"

import { redactImage, sampleRegion } from "@/lib/documents/image/redact"
import { newRedactionId } from "@/lib/documents/ids"
import { buildImagePlan } from "@/lib/redaction/apply"
import type { NormalizedDocument } from "@/types/document"
import type { Redaction } from "@/types/redaction"
import {
  IMAGE_BAND,
  IMAGE_DETAIL,
  makeExifImageFixture,
  makeImageFixture,
} from "./fixtures"

const BAND = IMAGE_BAND

describe("image redaction", () => {
  it("replaces the pixels of a redacted region", async () => {
    const bytes = await makeImageFixture()
    const before = await sampleRegion(bytes, BAND)
    expect(before.b).toBeGreaterThan(100)

    const output = await redactImage(bytes, {
      regions: [{ boundingBox: BAND }],
      defaultStyle: "solid",
      sanitizeMetadata: true,
    })

    const after = await sampleRegion(output, BAND)
    expect(after.r).toBeLessThan(5)
    expect(after.g).toBeLessThan(5)
    expect(after.b).toBeLessThan(5)
  })

  it("leaves the rest of the image alone", async () => {
    const bytes = await makeImageFixture()
    const output = await redactImage(bytes, {
      regions: [{ boundingBox: BAND }],
      defaultStyle: "solid",
      sanitizeMetadata: true,
    })

    const untouched = await sampleRegion(output, {
      x: 250,
      y: 200,
      width: 50,
      height: 50,
    })
    expect(untouched.r).toBeGreaterThan(250)
  })

  it("keeps the original dimensions", async () => {
    const bytes = await makeImageFixture()
    const output = await redactImage(bytes, {
      regions: [{ boundingBox: BAND }],
      defaultStyle: "solid",
      sanitizeMetadata: true,
    })

    const metadata = await sharp(Buffer.from(output)).metadata()
    expect(metadata.width).toBe(400)
    expect(metadata.height).toBe(300)
  })

  it("destroys fine detail when pixelating", async () => {
    const bytes = await makeImageFixture()
    const before = await sampleRegion(bytes, IMAGE_DETAIL)
    expect(before.r).toBeGreaterThan(250)

    const output = await redactImage(bytes, {
      regions: [{ boundingBox: BAND, style: "pixelate" }],
      defaultStyle: "solid",
      sanitizeMetadata: true,
    })

    // The white square is averaged into its block and is no longer recoverable.
    const after = await sampleRegion(output, IMAGE_DETAIL)
    expect(after.r).toBeLessThan(200)
  })

  it("destroys fine detail when blurring", async () => {
    const bytes = await makeImageFixture()
    const output = await redactImage(bytes, {
      regions: [{ boundingBox: BAND, style: "blur" }],
      defaultStyle: "solid",
      sanitizeMetadata: true,
    })

    const after = await sampleRegion(output, IMAGE_DETAIL)
    expect(after.r).toBeLessThan(200)
  })

  it("clips regions that run past the edge of the image", async () => {
    const bytes = await makeImageFixture()
    const output = await redactImage(bytes, {
      regions: [
        { boundingBox: { x: 380, y: 280, width: 200, height: 200 } },
        { boundingBox: { x: -20, y: -20, width: 60, height: 60 } },
      ],
      defaultStyle: "solid",
      sanitizeMetadata: true,
    })

    const corner = await sampleRegion(output, {
      x: 385,
      y: 285,
      width: 10,
      height: 10,
    })
    expect(corner.r).toBeLessThan(5)
  })

  it("strips EXIF and GPS metadata when asked", async () => {
    const bytes = await makeExifImageFixture()
    expect((await sharp(Buffer.from(bytes)).metadata()).exif).toBeDefined()

    const output = await redactImage(bytes, {
      regions: [{ boundingBox: { x: 10, y: 10, width: 40, height: 40 } }],
      defaultStyle: "solid",
      sanitizeMetadata: true,
    })

    const metadata = await sharp(Buffer.from(output)).metadata()
    expect(metadata.exif).toBeUndefined()
    expect(Buffer.from(output).toString("latin1")).not.toContain("Test Author")
  })

  it("keeps metadata when sanitization is turned off", async () => {
    const bytes = await makeExifImageFixture()
    const output = await redactImage(bytes, {
      regions: [{ boundingBox: { x: 10, y: 10, width: 40, height: 40 } }],
      defaultStyle: "solid",
      sanitizeMetadata: false,
    })

    expect((await sharp(Buffer.from(output)).metadata()).exif).toBeDefined()
  })
})

/**
 * OCR gives an image a page of text with a box behind every word, so a
 * detection over that text is a redaction with offsets and no geometry. It
 * reaches the pixels only if the export resolves it through those spans — the
 * same resolution the canvas draws with. These tests exist because the two
 * halves were built and never joined: the suggestions were produced, and
 * nothing placed them.
 */
function ocrModel(): NormalizedDocument {
  return {
    documentId: "doc_1",
    kind: "image",
    pages: [
      {
        number: 1,
        width: 400,
        height: 300,
        text: "ACCOUNT 12345678",
        spans: [
          {
            id: "ocr0",
            text: "ACCOUNT",
            start: 0,
            end: 7,
            // Deliberately elsewhere on the image: a redaction of the second
            // word must not cover the first.
            boundingBox: { x: 250, y: 200, width: 50, height: 20 },
            geometry: "word",
          },
          {
            id: "ocr1",
            text: "12345678",
            start: 8,
            end: 16,
            boundingBox: IMAGE_BAND,
            geometry: "word",
          },
        ],
        ocr: true,
      },
    ],
    regions: [],
  }
}

function textRedaction(overrides: Partial<Redaction> = {}): Redaction {
  return {
    id: newRedactionId(),
    documentId: "doc_1",
    type: "text",
    source: "ai",
    category: "account",
    status: "accepted",
    page: 1,
    text: "12345678",
    start: 8,
    end: 16,
    ...overrides,
  }
}

describe("image text redaction", () => {
  const options = { addLabels: false, sanitizeMetadata: true } as const

  it("removes the pixels under a word OCR read, from offsets alone", async () => {
    const bytes = await makeImageFixture()
    const plan = buildImagePlan(ocrModel(), [textRedaction()], options)

    expect(plan.regions.length).toBeGreaterThan(0)

    const output = await redactImage(bytes, plan)
    const after = await sampleRegion(output, IMAGE_DETAIL)

    expect(after.r).toBeLessThan(5)
    expect(after.g).toBeLessThan(5)
    expect(after.b).toBeLessThan(5)
  })

  it("leaves the words it did not cover alone", async () => {
    const bytes = await makeImageFixture()
    const plan = buildImagePlan(ocrModel(), [textRedaction()], options)
    const output = await redactImage(bytes, plan)

    const other = await sampleRegion(output, {
      x: 260,
      y: 205,
      width: 10,
      height: 10,
    })
    expect(other.r).toBeGreaterThan(250)
  })

  it("ignores a suggestion nobody accepted", async () => {
    const plan = buildImagePlan(
      ocrModel(),
      [textRedaction({ status: "suggested" })],
      options
    )

    expect(plan.regions).toEqual([])
  })

  it("fills text solid even when the export asks for blur", async () => {
    // Blur is offered for faces, where it reads better than a black bar. Text
    // is the one thing it must never be applied to: a blurred word of known
    // shape and a fixed alphabet is a puzzle, not a removal.
    const plan = buildImagePlan(ocrModel(), [textRedaction()], {
      ...options,
      imageStyle: "blur",
    })

    expect(plan.regions.every((region) => region.style === "solid")).toBe(true)
  })
})
