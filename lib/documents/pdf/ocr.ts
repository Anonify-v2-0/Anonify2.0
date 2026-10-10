import type { PDFDocumentProxy } from "pdfjs-dist"

import { mapWithConcurrency } from "@/lib/concurrency"
import { renderPage, RENDER_SCALE } from "@/lib/documents/pdf/render"
import { TextStreamBuilder } from "@/lib/documents/shared/text"
import { encodeRaster, type RasterFormat } from "@/lib/ocr/raster"
import { withCpuSlot } from "@/lib/runtime/cpu-slots"
import type { OcrGranularity, OcrResult, OcrWord } from "@/lib/ocr"
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

/** Reads one rendered page, encoded as the options' `format`. */
export type PageRecognizer = (image: Buffer) => Promise<OcrResult>

export const OCR_RENDER_SCALE_ENV = "ANONIFY_OCR_RENDER_SCALE"

/**
 * The scale scanned pages are drawn at for OCR: `ANONIFY_OCR_RENDER_SCALE`
 * (1–4), else the renderer's 2. Export draws at its own scale. Malformed
 * throws. See docs/pipelines.md for the study behind the default.
 */
export function ocrRenderScale(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[OCR_RENDER_SCALE_ENV]?.trim()
  if (!raw) return RENDER_SCALE
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 1 || value > 4)
    throw new Error(`${OCR_RENDER_SCALE_ENV} must be a number from 1 to 4`)
  return value
}

/**
 * Pages drawn ahead of the one being read (#189). Drawing happens on this
 * thread and reading on a worker's, so page 2 can be drawn while page 1 is
 * read. At most this many plus one encoded pages are alive at once.
 */
export const OCR_LOOKAHEAD = 2

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
  scale: number,
  granularity: OcrGranularity = "word"
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
      geometry: granularity,
    })
    builder.pad(" ")
  }

  return { text: builder.text, spans: builder.spans, words: index }
}

export type OcrPagesOptions = {
  scale?: number
  recognize: PageRecognizer
  /** How each page is encoded for `recognize`: PNG unless the engine says. */
  format?: RasterFormat
  lookahead?: number
}

/**
 * Rasterizes and reads the given pages. Returns only the pages that produced
 * usable text, so a page that is genuinely blank stays flagged rather than
 * being presented as successfully read.
 *
 * Pipelined (#189): pages are drawn one at a time, in order, and each is
 * handed to the engine as soon as it is drawn, with up to `lookahead` pages
 * drawn ahead of the slowest one still being read. The results land in a map
 * by page number, so nothing depends on which finished first.
 */
export async function ocrPdfPages(
  pdf: PDFDocumentProxy,
  pageNumbers: number[],
  options: OcrPagesOptions
): Promise<Map<number, OcrPageResult>> {
  const scale = options.scale ?? ocrRenderScale()
  const format = options.format ?? "png"
  const lookahead = Math.max(0, options.lookahead ?? OCR_LOOKAHEAD)
  const results = new Map<number, OcrPageResult>()

  const draw = async (pageNumber: number): Promise<Buffer> => {
    const page = await pdf.getPage(pageNumber)
    try {
      // Drawing and encoding in one CPU slot; the engine's workers are
      // bounded by its own pool.
      return await withCpuSlot(async () =>
        encodeRaster((await renderPage(page, scale)).canvas, format)
      )
    } finally {
      page.cleanup()
    }
  }

  // Drawing takes turns: pdf.js draws on this thread whatever the
  // concurrency, and one document proxy is not drawn from twice at once.
  let turn: Promise<unknown> = Promise.resolve()

  await mapWithConcurrency(pageNumbers, lookahead + 1, async (pageNumber) => {
    const drawn = turn.then(() => draw(pageNumber))
    turn = drawn.catch(() => {})
    const { words, granularity } = await options.recognize(await drawn)

    const result = spansFromWords(pageNumber, words, scale, granularity)
    if (result.words > 0) results.set(pageNumber, result)
  })

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
