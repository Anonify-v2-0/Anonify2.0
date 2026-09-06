import type { PDFDocumentProxy } from "pdfjs-dist"
import { PDFDocument } from "pdf-lib"

import {
  copyBytes,
  loadPdfjsForRender,
  renderPage,
  RENDER_SCALE,
} from "@/lib/documents/pdf/render"
import type { SKRSContext2D } from "@napi-rs/canvas"

import type { BoundingBox } from "@/types/document"

/**
 * PDF redaction.
 *
 * There is no way to paint over text in a PDF and call it redacted: the glyphs
 * stay in the content stream, selectable, searchable and trivially recoverable
 * by deleting an annotation. So a page carrying accepted redactions is rendered
 * to pixels, the redacted areas are painted on the raster, and the page is
 * rebuilt from that image. The characters are gone because the text objects
 * themselves are gone.
 *
 * Pages with no redactions are copied through untouched, so a hundred-page
 * document with one redacted page keeps ninety-nine pages of selectable text.
 */

/**
 * A box to remove, and what to paint on the strip that replaces it.
 *
 * `label` is the whole of the substitution story for a PDF. A page carrying a
 * redaction is rasterised, so there is no text stream left to write a
 * pseudonym into — but the strip is a rectangle this code draws, and drawing
 * it with `PERSON_014` on it puts the surrogate exactly where the value was.
 * A box with no label is a plain removal and falls back to the plan's marker.
 */
export type LabeledBox = BoundingBox & { label?: string }

export type PdfRedactionPlan = {
  /** Boxes to remove, in PDF user-space units with a top-left origin. */
  boxesByPage: Map<number, LabeledBox[]>
  label: string | null
  sanitizeMetadata: boolean
  /** Raster resolution for redacted pages. */
  scale?: number
}

const LABEL_FONT_RATIO = 0.6
const MIN_LABEL_HEIGHT = 8
/** Below this the glyphs stop being glyphs, and a smear is worse than nothing. */
const MIN_LABEL_PX = 6

/** Renders one page to PNG with the redacted areas already burned in. */
async function renderRedactedPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  boxes: LabeledBox[],
  label: string | null,
  scale: number
): Promise<{ png: Buffer; width: number; height: number }> {
  const page = await pdf.getPage(pageNumber)
  const rendered = await renderPage(page, scale)
  const canvas = rendered.canvas
  const context = canvas.getContext("2d")

  for (const box of boxes) {
    const x = box.x * scale
    const y = box.y * scale
    const width = box.width * scale
    const height = box.height * scale

    context.fillStyle = "#000000"
    context.fillRect(x, y, width, height)

    // A box's own label is a surrogate and outranks the plan's marker: the
    // marker says something was removed, the surrogate says what stands in
    // its place, and only one of them can be painted in the space available.
    const marker = box.label ?? label
    if (marker && height >= MIN_LABEL_HEIGHT) {
      drawStripText(context, marker, { x, y, width, height })
    }
  }

  page.cleanup()

  return {
    png: canvas.toBuffer("image/png"),
    width: rendered.width,
    height: rendered.height,
  }
}

/**
 * Paints a marker onto a strip, shrinking it until it fits.
 *
 * A strip is exactly as wide as the value it covers, and a surrogate is rarely
 * the same length as what it replaces, so "draw it at the obvious size" is not
 * an option. The type shrinks until the string fits or until it stops being
 * readable, and below that nothing is drawn: a strip with an illegible smear
 * on it reads as a rendering fault, while a plain strip reads as a redaction,
 * which is what it is. The vault still names what the strip stood for.
 */
function drawStripText(
  context: SKRSContext2D,
  marker: string,
  box: { x: number; y: number; width: number; height: number }
): void {
  context.fillStyle = "#ffffff"
  context.textBaseline = "middle"

  let size = Math.max(MIN_LABEL_PX, box.height * LABEL_FONT_RATIO)

  for (;;) {
    context.font = `${size}px sans-serif`
    const metrics = context.measureText(marker)
    if (metrics.width < box.width) {
      context.fillText(
        marker,
        box.x + (box.width - metrics.width) / 2,
        box.y + box.height / 2
      )
      return
    }
    if (size <= MIN_LABEL_PX) return
    size = Math.max(MIN_LABEL_PX, size - 1)
  }
}

export async function redactPdf(
  bytes: Uint8Array,
  plan: PdfRedactionPlan
): Promise<Uint8Array> {
  const scale = plan.scale ?? RENDER_SCALE
  const pdfjs = await loadPdfjsForRender()

  const task = pdfjs.getDocument({
    data: copyBytes(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: pdfjs.standardFontDataUrl,
    cMapUrl: pdfjs.cMapUrl,
    cMapPacked: true,
  })

  const rendered = await task.promise
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const output = await PDFDocument.create()

  try {
    for (let pageNumber = 1; pageNumber <= source.getPageCount(); pageNumber++) {
      const boxes = plan.boxesByPage.get(pageNumber) ?? []

      if (boxes.length === 0) {
        const [copied] = await output.copyPages(source, [pageNumber - 1])
        output.addPage(copied)
        continue
      }

      const { png, width, height } = await renderRedactedPage(
        rendered,
        pageNumber,
        boxes,
        plan.label,
        scale
      )

      const image = await output.embedPng(png)
      const page = output.addPage([width, height])
      page.drawImage(image, { x: 0, y: 0, width, height })
    }
  } finally {
    await task.destroy()
  }

  if (plan.sanitizeMetadata) {
    sanitizePdfMetadata(output)
  }

  return output.save({ useObjectStreams: true })
}

/** Clears authorship and tooling fingerprints from the exported document. */
export function sanitizePdfMetadata(pdf: PDFDocument): void {
  pdf.setTitle("")
  pdf.setAuthor("")
  pdf.setSubject("")
  pdf.setKeywords([])
  pdf.setProducer("")
  pdf.setCreator("")
  const epoch = new Date(0)
  pdf.setCreationDate(epoch)
  pdf.setModificationDate(epoch)
}

/** Extracts the text of an exported PDF, for the redaction-correctness tests. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await loadPdfjsForRender()
  const task = pdfjs.getDocument({
    data: copyBytes(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: pdfjs.standardFontDataUrl,
    cMapUrl: pdfjs.cMapUrl,
    cMapPacked: true,
  })

  const pdf = await task.promise
  const parts: string[] = []

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      for (const item of content.items) {
        if ("str" in item) parts.push(item.str)
      }
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }

  return parts.join(" ")
}
