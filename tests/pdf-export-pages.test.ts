import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import fontkit from "@pdf-lib/fontkit"
import { degrees, PDFDocument, rgb, type PDFFont } from "pdf-lib"
import { describe, expect, it } from "vitest"

import { extractPdf } from "@/lib/documents/pdf/extract"
import { newRedactionId } from "@/lib/documents/ids"
import { redactPdf } from "@/lib/documents/pdf/redact"
import {
  copyBytes,
  loadPdfjsForRender,
  renderPage,
} from "@/lib/documents/pdf/render"
import { buildPdfPlan } from "@/lib/redaction/apply"
import type { Redaction } from "@/types/redaction"

/**
 * PDF export, page by page (#174).
 *
 * Untouched pages are copied in one call rather than one call each, and a
 * redacted page's pixels go in as one deflated image instead of a PNG that
 * was decoded and deflated again. Neither may change what the export says:
 * the same pages in the same order at the same sizes, the untouched ones
 * with their text, and nothing of a redacted value anywhere.
 */

const require = createRequire(import.meta.url)
const LIBERATION = path.join(
  path.dirname(require.resolve("pdfjs-dist/package.json")),
  "standard_fonts",
  "LiberationSans-Regular.ttf"
)

const SECRET = "Josephine Marchetti"

/**
 * One embedded font shared by every page, which is what made copying a page
 * at a time duplicate it.
 */
async function sharedFontPdf(
  pages: number,
  line: (page: number) => string,
  rotate: Record<number, number> = {}
) {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font: PDFFont = await pdf.embedFont(readFileSync(LIBERATION), {
    subset: false,
  })
  for (let number = 1; number <= pages; number++) {
    const page = pdf.addPage([612, 792])
    if (rotate[number]) page.setRotation(degrees(rotate[number]))
    page.drawText(line(number), {
      x: 72,
      y: 700,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    })
    page.drawText(`Footer of page ${number}`, { x: 72, y: 60, size: 10, font })
  }
  return pdf.save()
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await loadPdfjsForRender()
  const task = pdfjs.getDocument({
    data: copyBytes(bytes),
    disableFontFace: true,
    useSystemFonts: false,
  })
  const pdf = await task.promise
  const texts: string[] = []
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      const content = await page.getTextContent()
      texts.push(
        content.items.map((item) => ("str" in item ? item.str : "")).join(" ")
      )
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return texts
}

/**
 * The plan an export would build for redacting `text` on `page`: the same
 * extraction and geometry the editor and the exporter use.
 */
async function planFor(
  bytes: Uint8Array,
  redact: { page: number; text: string }[]
) {
  const { document } = await extractPdf("doc", bytes)
  const redactions: Redaction[] = redact.map(({ page, text }) => {
    const start = document.pages[page - 1].text.indexOf(text)
    expect(start).toBeGreaterThanOrEqual(0)
    return {
      id: newRedactionId(),
      documentId: "doc",
      type: "text",
      source: "user",
      category: "person",
      status: "accepted",
      page,
      text,
      start,
      end: start + text.length,
    }
  })
  return buildPdfPlan(document, redactions, {
    addLabels: false,
    sanitizeMetadata: true,
  })
}

describe("PDF export by page", () => {
  it("removes a value set in a font the untouched pages next to it share", async () => {
    const source = await sharedFontPdf(3, (number) =>
      number === 2 ? `Patient: ${SECRET}` : `Ordinary text on page ${number}`
    )
    const output = await redactPdf(
      source,
      await planFor(source, [{ page: 2, text: SECRET }])
    )
    const texts = await pageTexts(output)
    const before = await pageTexts(source)

    expect(texts).toHaveLength(3)
    for (const text of texts) expect(text).not.toContain("Marchetti")
    expect(Buffer.from(output).toString("latin1")).not.toContain("Marchetti")
    expect(texts[0]).toBe(before[0])
    expect(texts[2]).toBe(before[2])
    expect(texts[1]).toBe("")
  })

  it("keeps 49 untouched pages of a 50-page document as they were, in order", async () => {
    const source = await sharedFontPdf(50, (number) =>
      number === 17
        ? `Signed by ${SECRET}`
        : `Page ${number} says nothing private`
    )
    const output = await redactPdf(
      source,
      await planFor(source, [{ page: 17, text: SECRET }])
    )
    const [before, after] = await Promise.all([
      pageTexts(source),
      pageTexts(output),
    ])

    expect(after).toHaveLength(50)
    after.forEach((text, index) => {
      if (index === 16) expect(text).toBe("")
      else expect(text).toBe(before[index])
    })

    const pdf = await PDFDocument.load(output)
    for (const page of pdf.getPages()) {
      expect(page.getSize()).toEqual({ width: 612, height: 792 })
    }
  })

  it("copies a shared font once, not once per page", async () => {
    const source = await sharedFontPdf(20, (number) =>
      number === 1 ? `Dear ${SECRET}` : `Page ${number}`
    )
    const output = await redactPdf(
      source,
      await planFor(source, [{ page: 1, text: SECRET }])
    )

    // The font is most of the source. Nineteen copies of it would be many
    // times the source's size; one is about the source plus one raster.
    expect(output.byteLength).toBeLessThan(source.byteLength * 2)
  })

  it("keeps the rotation of an untouched page and draws a rotated redacted page upright", async () => {
    const source = await sharedFontPdf(
      4,
      (number) => (number === 3 ? `Witness ${SECRET}` : `Page ${number}`),
      { 2: 90, 3: 90 }
    )
    const output = await redactPdf(
      source,
      await planFor(source, [{ page: 3, text: SECRET }])
    )
    const pdf = await PDFDocument.load(output)
    const pages = pdf.getPages()

    expect(pages.map((page) => page.getRotation().angle)).toEqual([0, 90, 0, 0])
    expect(pages[1].getSize()).toEqual({ width: 612, height: 792 })
    // The raster is of the page as it is seen, so it is already turned.
    expect(pages[2].getSize()).toEqual({ width: 792, height: 612 })
    expect((await pageTexts(output)).join(" ")).not.toContain("Marchetti")
  })

  it("paints the box where the value was, the right way up", async () => {
    const source = await sharedFontPdf(1, () => `Account holder ${SECRET}`)
    const plan = await planFor(source, [{ page: 1, text: SECRET }])
    const [box] = plan.boxesByPage.get(1)!
    const output = await redactPdf(source, plan)

    const pdfjs = await loadPdfjsForRender()
    const task = pdfjs.getDocument({
      data: copyBytes(output),
      disableFontFace: true,
      useSystemFonts: false,
    })
    try {
      const page = await (await task.promise).getPage(1)
      const { canvas } = await renderPage(page, 1)
      const context = canvas.getContext("2d")
      const pixel = (x: number, y: number) =>
        Array.from(
          context.getImageData(Math.round(x), Math.round(y), 1, 1).data
        )

      // The middle of the box is black, and so is nothing at the mirrored
      // spot a flipped image would have put it.
      expect(pixel(box.x + box.width / 2, box.y + box.height / 2)).toEqual([
        0, 0, 0, 255,
      ])
      expect(
        pixel(box.x + box.width / 2, 792 - (box.y + box.height / 2))
      ).toEqual([255, 255, 255, 255])
      // The words before it are still there, as pixels.
      let dark = 0
      for (let x = 72; x < box.x - 4; x += 1) {
        const [r] = pixel(x, box.y + box.height / 2)
        if (r < 128) dark++
      }
      expect(dark).toBeGreaterThan(5)
    } finally {
      await task.destroy()
    }
  })
})
