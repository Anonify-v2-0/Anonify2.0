import { deflateSync } from "node:zlib"

import type { PDFDocumentProxy } from "pdfjs-dist"
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  type PDFPage,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib"

import {
  copyBytes,
  loadPdfjsForRender,
  openPdfDocument,
  renderPage,
  RENDER_SCALE,
} from "@/lib/documents/pdf/render"
import { bufferRangeSource } from "@/lib/storage/range-source"
import type { Canvas, SKRSContext2D } from "@napi-rs/canvas"

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
  /** Called after each redacted page is drawn, for progress (#187). */
  onPage?: (done: number, total: number) => void
}

const LABEL_FONT_RATIO = 0.6
const MIN_LABEL_HEIGHT = 8
/** Below this the glyphs stop being glyphs, and a smear is worse than nothing. */
const MIN_LABEL_PX = 6

/** Renders one page with the redacted areas already burned in. */
async function renderRedactedPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  boxes: LabeledBox[],
  label: string | null,
  scale: number
): Promise<{ canvas: Canvas; width: number; height: number }> {
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

  return { canvas, width: rendered.width, height: rendered.height }
}

/**
 * Adds a rendered page to `output` as a full-page image, `width` by `height`
 * points.
 *
 * The pixels go in as raw RGB, deflated once by zlib (#174). This used to be
 * a PNG from the canvas, which pdf-lib then decoded again in JavaScript and
 * deflated a second time for the PDF. The pixels in the file are the same;
 * getting them there takes about a quarter of the time. JPEG was measured
 * too: no faster to speak of, and no smaller on pages that are mostly text,
 * so there is nothing to trade the ringing around unredacted glyphs for.
 */
function addRasterPage(
  output: PDFDocument,
  canvas: Canvas,
  width: number,
  height: number
): void {
  const image = output.context.register(flateImage(output, canvas))
  const page = output.addPage([width, height])
  const name = page.node.newXObject("Image", image)
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(width, 0, 0, height, 0, 0),
    drawObject(name),
    popGraphicsState()
  )
}

/**
 * The canvas as an RGB image XObject.
 *
 * The page was filled with white before anything was drawn on it, so every
 * pixel is opaque and dropping the alpha channel loses nothing.
 */
function flateImage(output: PDFDocument, canvas: Canvas) {
  const { width, height } = canvas
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data
  const rgb = Buffer.allocUnsafe(width * height * 3)
  for (let from = 0, to = 0; from < rgba.length; from += 4, to += 3) {
    rgb[to] = rgba[from]
    rgb[to + 1] = rgba[from + 1]
    rgb[to + 2] = rgba[from + 2]
  }

  return output.context.stream(deflateSync(rgb), {
    Type: "XObject",
    Subtype: "Image",
    Width: width,
    Height: height,
    ColorSpace: "DeviceRGB",
    BitsPerComponent: 8,
    Filter: "FlateDecode",
  })
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

  // pdf.js reads by ranges over the bytes already here, rather than being
  // handed a copy of the whole file (#187): it reads the index and the pages
  // it draws, and the source is held once, by pdf-lib, which needs all of it
  // to copy the untouched pages.
  const { task, guard } = await openPdfDocument(pdfjs, bufferRangeSource(bytes))

  const rendered = await guard(task.promise)
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const output = await PDFDocument.create()

  const pageCount = source.getPageCount()
  const redacted = (index: number) =>
    (plan.boxesByPage.get(index + 1)?.length ?? 0) > 0

  // Every untouched page in one call (#174). pdf-lib clones what a page
  // refers to once per call, so copying a page at a time cloned a font
  // shared by every page once per page, walking it again each time and
  // writing each clone into the output.
  const untouched = Array.from({ length: pageCount }, (_, index) => index).filter(
    (index) => !redacted(index)
  )
  const copies = new Map<number, PDFPage>()
  if (untouched.length > 0) {
    const copied = await output.copyPages(source, untouched)
    untouched.forEach((index, at) => copies.set(index, copied[at]))
  }

  const toDraw = pageCount - untouched.length
  let drawn = 0

  try {
    for (let index = 0; index < pageCount; index++) {
      const copy = copies.get(index)
      if (copy) {
        output.addPage(copy)
        continue
      }

      const { canvas, width, height } = await guard(
        renderRedactedPage(
          rendered,
          index + 1,
          plan.boxesByPage.get(index + 1) ?? [],
          plan.label,
          scale
        )
      )
      addRasterPage(output, canvas, width, height)
      plan.onPage?.(++drawn, toDraw)
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
