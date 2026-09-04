import type { PDFDocumentProxy } from "pdfjs-dist"

import { renderPage, RENDER_SCALE } from "@/lib/documents/pdf/render"
import { TextStreamBuilder } from "@/lib/documents/shared/text"
import type { OcrResult, OcrWord } from "@/lib/documents/image/extract"
import type { NormalizedPage } from "@/types/document"

/**
 * OCR for PDF pages that carry no extractable text.
 *
 * A scanned page is not a blank page. Extraction flags those pages; this reads
 * them, so a scanned document is reviewable exactly like a born-digital one
 * rather than arriving with nothing to review and no explanation.
 *
 * The recognizer is injected so the mapping below — raster pixels back into PDF
 * user space — can be tested without a language model download.
 */

/** Words below this confidence are noise more often than text. */
const MIN_WORD_CONFIDENCE = 40

export type PageRecognizer = (png: Buffer) => Promise<OcrResult>

export type OcrPageResult = {
  text: string
  spans: NormalizedPage["spans"]
  words: number
}

/**
 * Converts one page's OCR words into spans.
 *
 * Boxes come back in raster pixels at `scale`; the rest of the system works in
 * PDF user-space units, so they are divided once here. The raster was rendered
 * from the same top-down viewport the extractor uses, so no flip is needed —
 * flipping twice is how boxes end up mirrored.
 */
export function spansFromWords(
  pageNumber: number,
  words: OcrWord[],
  scale: number
): OcrPageResult {
  const builder = new TextStreamBuilder()
  let index = 0

  for (const word of words) {
    if (word.confidence < MIN_WORD_CONFIDENCE) continue
    const text = word.text.trim()
    if (text.length === 0) continue

    builder.append(`p${pageNumber}o${index++}`, text, {
      boundingBox: {
        x: word.bbox.x0 / scale,
        y: word.bbox.y0 / scale,
        width: (word.bbox.x1 - word.bbox.x0) / scale,
        height: (word.bbox.y1 - word.bbox.y0) / scale,
      },
    })
    builder.pad(" ")
  }

  return { text: builder.text, spans: builder.spans, words: index }
}

export type OcrPagesOptions = {
  scale?: number
  recognize: PageRecognizer
}

/**
 * Rasterizes and reads the given pages. Returns only the pages that produced
 * usable text, so a page that is genuinely blank stays flagged rather than
 * being presented as successfully read.
 */
export async function ocrPdfPages(
  pdf: PDFDocumentProxy,
  pageNumbers: number[],
  options: OcrPagesOptions
): Promise<Map<number, OcrPageResult>> {
  const scale = options.scale ?? RENDER_SCALE
  const results = new Map<number, OcrPageResult>()

  for (const pageNumber of pageNumbers) {
    const page = await pdf.getPage(pageNumber)
    try {
      const rendered = await renderPage(page, scale)
      const png = rendered.canvas.toBuffer("image/png")
      const { words } = await options.recognize(png)

      const result = spansFromWords(pageNumber, words, scale)
      if (result.words > 0) results.set(pageNumber, result)
    } finally {
      page.cleanup()
    }
  }

  return results
}

/** Merges an OCR result into the page it came from. */
export function mergeOcrIntoPage(
  page: NormalizedPage,
  result: OcrPageResult
): NormalizedPage {
  return {
    ...page,
    text: result.text,
    spans: result.spans,
    ocr: true,
  }
}
