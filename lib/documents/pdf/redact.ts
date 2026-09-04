import { createCanvas } from "@napi-rs/canvas"
import type { PDFDocumentProxy } from "pdfjs-dist"
import { PDFDocument } from "pdf-lib"

import { copyBytes, loadPdfjsForRender } from "@/lib/documents/pdf/render"
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

export type PdfRedactionPlan = {
  /** Boxes to remove, in PDF user-space units with a top-left origin. */
  boxesByPage: Map<number, BoundingBox[]>
  label: string | null
  sanitizeMetadata: boolean
  /** Raster resolution for redacted pages. */
  scale?: number
}

const DEFAULT_SCALE = 2
const LABEL_FONT_RATIO = 0.6
const MIN_LABEL_HEIGHT = 8

/** Renders one page to PNG with the redacted areas already burned in. */
async function renderRedactedPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  boxes: BoundingBox[],
  label: string | null,
  scale: number
): Promise<{ png: Buffer; width: number; height: number }> {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale })

  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height)
  )
  const context = canvas.getContext("2d")

  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)

  await page.render({
    // The napi canvas is API-compatible with the DOM one pdf.js expects.
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise

  for (const box of boxes) {
    const x = box.x * scale
    const y = box.y * scale
    const width = box.width * scale
    const height = box.height * scale

    context.fillStyle = "#000000"
    context.fillRect(x, y, width, height)

    if (label && height >= MIN_LABEL_HEIGHT) {
      context.fillStyle = "#ffffff"
      context.font = `${Math.max(6, height * LABEL_FONT_RATIO)}px sans-serif`
      context.textBaseline = "middle"
      const metrics = context.measureText(label)
      if (metrics.width < width) {
        context.fillText(label, x + (width - metrics.width) / 2, y + height / 2)
      }
    }
  }

  page.cleanup()

  return {
    png: canvas.toBuffer("image/png"),
    width: viewport.width / scale,
    height: viewport.height / scale,
  }
}

export async function redactPdf(
  bytes: Uint8Array,
  plan: PdfRedactionPlan
): Promise<Uint8Array> {
  const scale = plan.scale ?? DEFAULT_SCALE
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
