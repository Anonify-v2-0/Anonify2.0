import { readFileSync } from "node:fs"
import path from "node:path"

import { expect, it } from "vitest"

import { extractImage } from "@/lib/documents/image/extract"
import { redactImage, sampleRegion } from "@/lib/documents/image/redact"
import { newRedactionId } from "@/lib/documents/ids"
import { ocrImage } from "@/lib/ocr"
import { tesseractProvider } from "@/lib/ocr/tesseract"
import { buildImagePlan } from "@/lib/redaction/apply"
import type { BoundingBox } from "@/types/document"
import { makeImageFixture } from "./fixtures"
import { describeWithOcrModel } from "./helpers/ocr-model"

/**
 * The real Tesseract engine, against a committed image with known text.
 *
 * The boxes matter more than the words. OCR spans are what the image canvas
 * draws suggestions from and what the exporter paints over, so a test that
 * checked only that the words were read would pass while every redaction landed
 * beside the value it was meant to remove. The expected boxes were measured
 * from the fixture's pixels when it was drawn (tests/fixtures/ocr/generate.ts),
 * so they owe nothing to the engine under test.
 */

type Truth = {
  width: number
  height: number
  words: { text: string; box: BoundingBox }[]
}

const FIXTURE = path.join(import.meta.dirname, "fixtures", "ocr")
const image = new Uint8Array(readFileSync(path.join(FIXTURE, "account.png")))
const truth: Truth = JSON.parse(
  readFileSync(path.join(FIXTURE, "account.json"), "utf8")
)

/** How far an edge may sit from the ink, in pixels. */
const TOLERANCE = 3

function expectBoxOnInk(actual: BoundingBox | undefined, word: string) {
  const expected = truth.words.find((w) => w.text === word)!.box
  expect(actual, `a box for "${word}"`).toBeDefined()
  const edges = (box: BoundingBox) => [
    box.x,
    box.y,
    box.x + box.width,
    box.y + box.height,
  ]
  const got = edges(actual!)
  edges(expected).forEach((edge, index) => {
    expect(
      Math.abs(got[index] - edge),
      `"${word}" edge ${index}: ${got[index]} vs ${edge}`
    ).toBeLessThanOrEqual(TOLERANCE)
  })
}

const OCR_TIMEOUT = 60_000

describeWithOcrModel("Tesseract OCR", () => {
  it(
    "reads every word with a box on its own ink",
    async () => {
      const result = await ocrImage(image)

      expect(result.granularity).toBe("word")
      expect(result.words.map((w) => w.text)).toEqual(
        truth.words.map((w) => w.text)
      )
      for (const word of result.words) {
        expectBoxOnInk(
          {
            x: word.bbox.x0,
            y: word.bbox.y0,
            width: word.bbox.x1 - word.bbox.x0,
            height: word.bbox.y1 - word.bbox.y0,
          },
          word.text
        )
      }
    },
    OCR_TIMEOUT
  )

  it(
    "reads page after page with one worker, and closes it",
    async () => {
      // A session is started once per document and reused across its pages;
      // a worker that is not terminated keeps the process alive after the job.
      for (let cycle = 0; cycle < 2; cycle++) {
        const session = await tesseractProvider.start()
        try {
          const first = await session.recognize(image)
          const second = await session.recognize(image)
          expect(second.words).toEqual(first.words)
        } finally {
          await session.close()
        }
      }
    },
    OCR_TIMEOUT
  )

  it(
    "turns a scan into a page whose spans sit on the words",
    async () => {
      const { document, imageClass } = await extractImage("doc_1", image)
      const page = document.pages[0]

      expect(imageClass).toBe("document")
      expect(page).toMatchObject({
        number: 1,
        width: truth.width,
        height: truth.height,
        ocr: true,
      })
      expect(page.text.trim()).toBe("ACCOUNT 12345678 Patient Smith")

      expect(page.spans.map((span) => span.text)).toEqual(
        truth.words.map((w) => w.text)
      )
      for (const span of page.spans) {
        // Offsets are how a text detection finds its span, and the span is
        // where its box comes from; both halves have to agree.
        expect(page.text.slice(span.start, span.end)).toBe(span.text)
        expect(span.geometry).toBe("word")
        expectBoxOnInk(span.boundingBox, span.text)
      }

      // The regions the canvas snaps to carry the same geometry.
      for (const region of document.regions ?? []) {
        expectBoxOnInk(region.boundingBox, region.text!)
      }
    },
    OCR_TIMEOUT
  )

  it(
    "paints over the value it was asked to, and nothing else",
    async () => {
      // The whole chain the reviewer relies on: read the scan, accept one value
      // by its offsets, export, and read the export back.
      const { document } = await extractImage("doc_1", image)
      const page = document.pages[0]
      const start = page.text.indexOf("12345678")

      const plan = buildImagePlan(
        document,
        [
          {
            id: newRedactionId(),
            documentId: "doc_1",
            type: "text",
            source: "ai",
            category: "bank-account",
            status: "accepted",
            page: 1,
            text: "12345678",
            start,
            end: start + "12345678".length,
          },
        ],
        { addLabels: false, sanitizeMetadata: true }
      )
      const output = await redactImage(image, plan)

      const covered = await sampleRegion(
        output,
        truth.words.find((w) => w.text === "12345678")!.box
      )
      expect(covered.r).toBeLessThan(5)

      const reread = await ocrImage(output)
      const words = reread.words.map((w) => w.text)
      expect(words.join(" ")).not.toMatch(/\d{4}/)
      expect(words).toEqual(
        expect.arrayContaining(["ACCOUNT", "Patient", "Smith"])
      )
    },
    OCR_TIMEOUT
  )

  it(
    "calls a picture with no text a photograph",
    async () => {
      const { document, imageClass } = await extractImage(
        "doc_1",
        await makeImageFixture()
      )

      expect(imageClass).toBe("photograph")
      expect(document.pages[0].spans).toEqual([])
      expect(document.pages[0].ocr).toBeUndefined()
      expect(document.regions).toEqual([])
    },
    OCR_TIMEOUT
  )
})
