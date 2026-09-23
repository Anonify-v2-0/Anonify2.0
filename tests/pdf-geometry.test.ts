import { PDFDocument, rgb, setWordSpacing, StandardFonts, type PDFFont } from "pdf-lib"
import { describe, expect, it } from "vitest"

import { characterOffsets } from "@/lib/documents/pdf/glyphs"
import { extractPdf } from "@/lib/documents/pdf/extract"
import { redactPdf } from "@/lib/documents/pdf/redact"
import { copyBytes, loadPdfjsForRender, renderPage } from "@/lib/documents/pdf/render"
import { boxesForRedaction, boxForRange, padBox } from "@/lib/redaction/geometry"
import type { BoundingBox, NormalizedPage } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * Where a PDF redaction box lands.
 *
 * A run of PDF text is often a whole line, and its box used to be sliced as if
 * every character were the same width. In proportional type that put the box
 * characters away from its value by the end of a line, and the export burned
 * the misplaced box into the pixels while its text check passed, because a
 * rasterised page has no text to find. These tests hold the geometry to the
 * font's own metrics, and the export to what is actually painted.
 */

const SIZE = 10.5
const BASELINE = 700
const LEFT = 60

/** Values at the start, the middle and the end of one line. */
const LINE = [
  "4242",
  " is the card, the insurer is ",
  "Aldwych Health",
  " and the account is ",
  "31926819",
] as const
const VALUES = ["4242", "Aldwych Health", "31926819"]

type Fixture = {
  bytes: Uint8Array
  /** Where each value's glyphs really are, from the font's AFM widths. */
  truth: Map<string, { x: number; width: number }>
  font: PDFFont
}

/**
 * Glyph advances with no kerning. pdf-lib's `widthOfTextAtSize` applies AFM
 * kerning pairs, but its `drawText` does not, and neither does the page.
 */
function advance(font: PDFFont, text: string): number {
  return [...text].reduce((sum, char) => sum + font.widthOfTextAtSize(char, SIZE), 0)
}

async function lineFixture(
  standard: StandardFonts,
  wordSpacing = 0
): Promise<Fixture> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const font = await pdf.embedFont(standard)
  const text = LINE.join("")

  // Word spacing is what justified text uses. It widens every space, so the
  // run is wider than its glyphs account for.
  if (wordSpacing) page.pushOperators(setWordSpacing(wordSpacing))
  page.drawText(text, { x: LEFT, y: BASELINE, size: SIZE, font, color: rgb(0, 0, 0) })

  const truth = new Map<string, { x: number; width: number }>()
  let x = LEFT
  for (const part of LINE) {
    const spaces = [...part].filter((char) => char === " ").length
    const width = advance(font, part) + spaces * wordSpacing
    if (VALUES.includes(part)) truth.set(part, { x, width })
    x += width
  }

  return { bytes: await pdf.save(), truth, font }
}

/**
 * The value's range in the page text. Found whitespace-insensitively: pdf.js
 * breaks word-spaced text into a run per word, and the gaps between runs come
 * through as more than one space.
 */
function redactionOf(page: NormalizedPage, value: string): Redaction {
  const pattern = new RegExp(value.split(/\s+/).join("\\s+"))
  const match = pattern.exec(page.text)
  expect(match, value).not.toBeNull()
  const start = match!.index
  return {
    id: `r_${value}`,
    documentId: "doc",
    type: "text",
    source: "ai",
    category: "person",
    status: "accepted",
    page: 1,
    start,
    end: start + match![0].length,
  }
}

describe("where a PDF redaction box lands", () => {
  for (const [label, standard] of [
    ["Helvetica", StandardFonts.Helvetica],
    ["Times", StandardFonts.TimesRoman],
  ] as const) {
    it(`covers each value on a ${label} line exactly, start, middle and end`, async () => {
      const { bytes, truth } = await lineFixture(standard)
      const page = (await extractPdf("doc", bytes)).document.pages[0]

      for (const value of VALUES) {
        const box = extent(boxesForRedaction(page, redactionOf(page, value)))
        const expected = truth.get(value)!
        expect(box.x).toBeCloseTo(expected.x, 0)
        expect(box.x + box.width).toBeCloseTo(expected.x + expected.width, 0)
      }
    })
  }

  it("follows justified text, whose width went into the spaces", async () => {
    const { bytes, truth } = await lineFixture(StandardFonts.Helvetica, 4)
    const page = (await extractPdf("doc", bytes)).document.pages[0]

    for (const value of VALUES) {
      const box = extent(boxesForRedaction(page, redactionOf(page, value)))
      const expected = truth.get(value)!
      expect(Math.abs(box.x - expected.x)).toBeLessThan(0.75)
      expect(Math.abs(box.x + box.width - (expected.x + expected.width))).toBeLessThan(0.75)
    }
  })

  it("reaches below the baseline, far enough for descenders", async () => {
    const { bytes, font } = await lineFixture(StandardFonts.Helvetica)
    const page = (await extractPdf("doc", bytes)).document.pages[0]
    const [box] = boxesForRedaction(page, redactionOf(page, "Aldwych Health"))

    // Top-down page coordinates: the baseline sits at height - BASELINE.
    const baseline = 792 - BASELINE
    // Helvetica's AFM descender is -207 per 1000.
    const descent = 0.207 * SIZE
    expect(box.y + box.height).toBeGreaterThanOrEqual(baseline + descent - 0.01)
    expect(box.y).toBeLessThanOrEqual(baseline - font.heightAtSize(SIZE) * 0.7)
  })

  it("leaves no ink of an accepted value in the exported pixels", async () => {
    const { bytes, truth } = await lineFixture(StandardFonts.Helvetica)
    const page = (await extractPdf("doc", bytes)).document.pages[0]

    const boxes = VALUES.flatMap((value) =>
      boxesForRedaction(page, redactionOf(page, value)).map((box) => padBox(box))
    )
    const exported = await redactPdf(bytes, {
      boxesByPage: new Map([[1, boxes]]),
      label: null,
      sanitizeMetadata: true,
    })

    const scale = 2
    const before = await rasterise(bytes, scale)
    const after = await rasterise(exported, scale)

    for (const value of VALUES) {
      const { x, width } = truth.get(value)!
      // Every pixel the value inked, from a line above the cap height to
      // below the descenders.
      let found = 0
      for (let py = Math.floor((792 - BASELINE - SIZE) * scale); py < Math.ceil((792 - BASELINE + SIZE * 0.3) * scale); py++) {
        for (let px = Math.floor(x * scale); px < Math.ceil((x + width) * scale); px++) {
          if (!before.dark(px, py)) continue
          found++
          expect(after.dark(px, py), `${value} at ${px},${py}`).toBe(true)
          expect(after.black(px, py), `${value} at ${px},${py}`).toBe(true)
        }
      }
      expect(found, `${value} painted something to check`).toBeGreaterThan(20)
    }
  })
})

describe("character offsets across a run", () => {
  const widths = new Map([
    ["i", 222],
    ["W", 944],
    [" ", 278],
  ])

  it("places characters by their own widths, not an even share", () => {
    const offsets = characterOffsets("iW i", 16.66, 10, widths)!
    expect(offsets.map((value) => Number(value.toFixed(2)))).toEqual([
      0, 2.22, 11.66, 14.44, 16.66,
    ])
  })

  it("covers a run whole when it cannot measure it", () => {
    expect(characterOffsets("€€€", 30, 10, widths)).toBeNull()
    expect(characterOffsets("iWi", 30, 10, undefined)).toBeNull()
  })

  it("gives a slice from measured offsets, not from the run's length", () => {
    const span = {
      id: "s",
      text: "iW i",
      start: 0,
      end: 4,
      boundingBox: { x: 100, y: 0, width: 16.66, height: 12 },
      offsets: characterOffsets("iW i", 16.66, 10, widths)!,
    }
    const box = boxForRange(span, 1, 2)!
    expect(box.x).toBeCloseTo(102.22, 2)
    expect(box.width).toBeCloseTo(9.44, 2)
  })

  it("keeps one offset per code unit when a character is outside the BMP", () => {
    const offsets = characterOffsets("i𝐖i", 20, 10, new Map([["i", 250], ["𝐖", 1000]]))!
    expect(offsets).toHaveLength("i𝐖i".length + 1)
    expect(offsets[1]).toBe(offsets[2])
  })
})

describe("a PDF analysed before positions were measured", () => {
  it("is covered whole, and down past the baseline", () => {
    const legacy = {
      id: "s",
      text: "card ending 4242 on file",
      start: 0,
      end: 24,
      boundingBox: { x: 100, y: 50, width: 120, height: 10 },
    }
    const box = boxForRange(legacy, 12, 16)!
    expect(box.x).toBe(100)
    expect(box.width).toBe(120)
    expect(box.y + box.height).toBeGreaterThan(60)
  })
})

/** One line's boxes as the span from the first to the last. */
function extent(boxes: BoundingBox[]): BoundingBox {
  expect(boxes.length).toBeGreaterThan(0)
  const left = Math.min(...boxes.map((box) => box.x))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  return { ...boxes[0], x: left, width: right - left }
}

async function rasterise(bytes: Uint8Array, scale: number) {
  const pdfjs = await loadPdfjsForRender()
  const task = pdfjs.getDocument({
    data: copyBytes(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: pdfjs.standardFontDataUrl,
  })
  const pdf = await task.promise
  try {
    const { canvas } = await renderPage(await pdf.getPage(1), scale)
    const { data, width } = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height)
    const at = (x: number, y: number) => (y * width + x) * 4
    return {
      dark: (x: number, y: number) => data[at(x, y)] < 128,
      black: (x: number, y: number) =>
        data[at(x, y)] === 0 && data[at(x, y) + 1] === 0 && data[at(x, y) + 2] === 0,
    }
  } finally {
    await task.destroy()
  }
}
