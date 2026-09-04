import sharp from "sharp"
import { describe, expect, it } from "vitest"

import { redactImage, sampleRegion } from "@/lib/documents/image/redact"
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
