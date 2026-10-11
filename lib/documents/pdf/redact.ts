import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  type PDFPage,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib"

import { openPageRenderer } from "@/lib/documents/pdf/page-renderer"
import {
  copyBytes,
  loadPdfjsForRender,
  RENDER_SCALE,
} from "@/lib/documents/pdf/render"
import type { EncodedPage } from "@/lib/documents/pdf/raster-core.mjs"
import { bufferRangeSource } from "@/lib/storage/range-source"

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

/**
 * Adds a redacted page to `output` as a full-page image, `width` by `height`
 * points.
 *
 * The page was drawn, its boxes burned in and its pixels deflated as raw RGB
 * on a render thread (#194, raster-core.mjs); here they only become an image
 * XObject. It used to be a PNG from the canvas, which pdf-lib then decoded
 * again in JavaScript and deflated a second time for the PDF (#174). JPEG was
 * measured too: no faster to speak of, and no smaller on pages that are
 * mostly text, so there is nothing to trade the ringing around unredacted
 * glyphs for.
 */
function addRasterPage(output: PDFDocument, drawn: EncodedPage): void {
  const image = output.context.register(
    output.context.stream(drawn.data, {
      Type: "XObject",
      Subtype: "Image",
      Width: drawn.pixelWidth,
      Height: drawn.pixelHeight,
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
      Filter: "FlateDecode",
    })
  )
  const { width, height } = drawn
  const page = output.addPage([width, height])
  const name = page.node.newXObject("Image", image)
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(width, 0, 0, height, 0, 0),
    drawObject(name),
    popGraphicsState()
  )
}

export async function redactPdf(
  bytes: Uint8Array,
  plan: PdfRedactionPlan
): Promise<Uint8Array> {
  const scale = plan.scale ?? RENDER_SCALE
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const output = await PDFDocument.create()

  const pageCount = source.getPageCount()
  const redacted = (index: number) =>
    (plan.boxesByPage.get(index + 1)?.length ?? 0) > 0

  // Every untouched page in one call (#174). pdf-lib clones what a page
  // refers to once per call, so copying a page at a time cloned a font
  // shared by every page once per page, walking it again each time and
  // writing each clone into the output.
  const untouched = Array.from(
    { length: pageCount },
    (_, index) => index
  ).filter((index) => !redacted(index))
  const copies = new Map<number, PDFPage>()
  if (untouched.length > 0) {
    const copied = await output.copyPages(source, untouched)
    untouched.forEach((index, at) => copies.set(index, copied[at]))
  }

  const toDraw = pageCount - untouched.length
  let drawn = 0

  // pdf.js reads by ranges over the bytes already here, rather than being
  // handed a copy of the whole file (#187): it reads the index and the pages
  // it draws, and the source is held once, by pdf-lib, which needs all of it
  // to copy the untouched pages. On a render thread (#194) the ranges are
  // sent to it as they are asked for. Nothing to draw, nothing opened.
  const renderer =
    toDraw > 0 ? await openPageRenderer(bufferRangeSource(bytes)) : null

  try {
    for (let index = 0; index < pageCount; index++) {
      const copy = copies.get(index)
      if (copy) {
        output.addPage(copy)
        continue
      }

      addRasterPage(
        output,
        await renderer!.draw(index + 1, {
          scale,
          output: "flate-rgb",
          boxes: plan.boxesByPage.get(index + 1) ?? [],
          label: plan.label,
        })
      )
      plan.onPage?.(++drawn, toDraw)
    }
  } finally {
    await renderer?.close()
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
