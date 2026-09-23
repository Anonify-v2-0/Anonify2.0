import { startOcr } from "@/lib/ocr"
import {
  characterOffsets,
  collectFontWidths,
  type FontWidths,
} from "@/lib/documents/pdf/glyphs"
import {
  mergeOcrIntoPage,
  ocrPdfPages,
  type PageRecognizer,
} from "@/lib/documents/pdf/ocr"
import { copyBytes, loadPdfjsForRender } from "@/lib/documents/pdf/render"
import { TextStreamBuilder } from "@/lib/documents/shared/text"
import type {
  BoundingBox,
  NormalizedDocument,
  NormalizedPage,
  SpanGeometry,
  TextStyle,
} from "@/types/document"

/**
 * PDF extraction.
 *
 * Text-based PDFs keep their glyph geometry: every span carries the box it
 * occupies on the page, so the canvas can highlight exactly what the detector
 * matched and the exporter can paint over exactly what the user accepted.
 * Pages that carry no extractable text are flagged for OCR instead of being
 * silently treated as empty.
 */

type PdfTextItem = {
  str: string
  dir?: string
  width?: number
  height?: number
  transform: number[]
  fontName?: string
  hasEOL?: boolean
}

type PdfTextStyle = {
  fontFamily?: string
  ascent?: number
  descent?: number
  vertical?: boolean
}

/** Below this many characters a page is treated as scanned rather than empty. */
const OCR_TEXT_THRESHOLD = 16

/**
 * How far below the baseline a glyph may reach, as a share of the font size,
 * when the font does not say. Generous on purpose: the box has to cover the
 * tail of a `g` or a `p`, and a descent is under a quarter of the em in
 * every common face.
 */
const FALLBACK_DESCENT = 0.25

type Operators = Record<string, number>

type OperatorList = { fnArray: number[]; argsArray: unknown[] }

/**
 * Where a run of text sits on the page, top-down, and how finely.
 *
 * The box runs from one em above the baseline, which clears capitals and
 * accents, to the font's descent below it. It used to stop at the baseline,
 * which left the descenders of every redacted value showing under the box.
 *
 * A run that is not horizontal left to right gets a box around the whole of
 * it and `block` geometry, so a redaction covers the run rather than a slice
 * measured along the wrong axis.
 */
function placeRun(
  item: PdfTextItem,
  pageHeight: number,
  styles: Record<string, PdfTextStyle>,
  widths: FontWidths
): {
  boundingBox: BoundingBox
  fontSize: number
  geometry?: SpanGeometry
  offsets?: number[]
} {
  const [a, b, c, d, translateX, translateY] = item.transform
  const fontSize =
    item.height && item.height > 0 ? item.height : Math.hypot(c, d)
  const width = item.width ?? 0
  const style = item.fontName ? styles[item.fontName] : undefined
  const descent =
    typeof style?.descent === "number" && style.descent < 0
      ? Math.max(-style.descent, FALLBACK_DESCENT / 2)
      : FALLBACK_DESCENT
  const above = fontSize
  const below = fontSize * descent

  const horizontal = Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a > 0
  if (!horizontal || item.dir === "rtl") {
    // The run's rectangle in text space, from its origin along its baseline,
    // mapped through its own transform and boxed on the page.
    const unit = Math.hypot(a, b) || 1
    const along = [a / unit, b / unit]
    const up = [c / (Math.hypot(c, d) || 1), d / (Math.hypot(c, d) || 1)]
    const corners = [
      [0, -below],
      [width, -below],
      [0, above],
      [width, above],
    ].map(([u, v]) => [
      translateX + along[0] * u + up[0] * v,
      translateY + along[1] * u + up[1] * v,
    ])
    const xs = corners.map(([x]) => x)
    const ys = corners.map(([, y]) => pageHeight - y)
    return {
      boundingBox: {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      },
      fontSize,
      geometry: "block",
    }
  }

  const offsets = characterOffsets(
    item.str,
    width,
    a,
    item.fontName ? widths.get(item.fontName) : undefined
  )

  return {
    boundingBox: {
      x: translateX,
      // PDF space is bottom-up; the canvas and the exporter both work
      // top-down, so flip once here and never again.
      y: pageHeight - translateY - above,
      width,
      height: above + below,
    },
    fontSize,
    // Without measured positions a slice would be a guess, so the whole run
    // is covered instead: visible on the canvas, never a silent leak.
    geometry: offsets ? undefined : "block",
    offsets: offsets
      ? offsets.map((value) => Math.round(value * 100) / 100)
      : undefined,
  }
}

function styleFrom(
  fontName: string | undefined,
  styles: Record<string, PdfTextStyle>,
  fontSize: number
): TextStyle {
  const family = (fontName && styles[fontName]?.fontFamily) || fontName || ""
  return {
    fontFamily: family || undefined,
    fontSize: Number(fontSize.toFixed(2)),
    bold: /bold|black|heavy|semibold/i.test(family) || undefined,
    italic: /italic|oblique/i.test(family) || undefined,
  }
}

export type PdfExtraction = {
  document: NormalizedDocument
  /** Pages that had no embedded text. Empty once OCR has read them. */
  ocrPages: number[]
}

export type PdfExtractOptions = {
  /**
   * Read text-free pages with OCR. Off by default because it is slow and pulls
   * in language data; the pipeline turns it on, tests can inject a recognizer.
   */
  ocr?: boolean
  /** Overrides the recognizer, so the mapping can be tested without tesseract. */
  recognize?: PageRecognizer
}

export async function extractPdf(
  documentId: string,
  bytes: Uint8Array,
  options: PdfExtractOptions = {}
): Promise<PdfExtraction> {
  const pdfjs = await loadPdfjsForRender()

  const task = pdfjs.getDocument({
    data: copyBytes(bytes),
    // Untrusted input: no font-face injection, no network font fetches.
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: pdfjs.standardFontDataUrl,
    cMapUrl: pdfjs.cMapUrl,
    cMapPacked: true,
  })

  const pdf = await task.promise
  const pages: NormalizedPage[] = []
  const ocrPages: number[] = []
  let remaining: number[] = []

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const styles = (content.styles ?? {}) as Record<string, PdfTextStyle>
      const operators = await operatorList(page)
      const widths = operators
        ? collectFontWidths(pdfjs.OPS, operators)
        : new Map()

      const builder = new TextStreamBuilder()
      let index = 0

      for (const raw of content.items as PdfTextItem[]) {
        if (!("str" in raw)) continue
        const item = raw
        if (item.str.length > 0) {
          const run = placeRun(item, viewport.height, styles, widths)

          builder.append(`p${pageNumber}s${index++}`, item.str, {
            boundingBox: run.boundingBox,
            style: styleFrom(item.fontName, styles, run.fontSize),
            ...(run.geometry ? { geometry: run.geometry } : {}),
            ...(run.offsets ? { offsets: run.offsets } : {}),
          })
        }

        if (item.hasEOL) {
          builder.pad("\n")
        } else if (item.str.length > 0 && !item.str.endsWith(" ")) {
          builder.pad(" ")
        }
      }

      // Asked before cleanup(), which discards the page's operator list.
      const images = operators ? pageHasImages(pdfjs.OPS, operators) : false

      page.cleanup()

      const text = builder.text
      const needsOcr = text.trim().length < OCR_TEXT_THRESHOLD
      if (needsOcr) {
        ocrPages.push(pageNumber)
        remaining.push(pageNumber)
      }

      pages.push({
        number: pageNumber,
        width: viewport.width,
        height: viewport.height,
        text,
        spans: builder.spans,
        ocr: needsOcr ? true : undefined,
        images: images ? true : undefined,
      })
    }
    // Scanned pages are read here, while the document is still open, rather
    // than reparsing the file. A page that OCR could not read stays flagged
    // instead of being presented as successfully read and empty.
    if (options.ocr && ocrPages.length > 0) {
      const recognizer = options.recognize
        ? { recognize: options.recognize, close: async () => {} }
        : await startOcrRecognizer()

      try {
        const read = await ocrPdfPages(pdf, ocrPages, {
          recognize: recognizer.recognize,
        })

        for (const [pageNumber, result] of read) {
          const index = pages.findIndex((page) => page.number === pageNumber)
          if (index !== -1) {
            pages[index] = mergeOcrIntoPage(pages[index], result)
          }
        }

        remaining = ocrPages.filter((pageNumber) => !read.has(pageNumber))
      } finally {
        await recognizer.close()
      }
    }
  } finally {
    await task.destroy()
  }

  return {
    document: {
      documentId,
      kind: "pdf",
      pages,
      metadata: {
        pageCount: pages.length,
        ocrPages: pages.filter((page) => page.ocr).map((page) => page.number),
      },
    },
    ocrPages: remaining,
  }
}

/**
 * The page's operator list, or null when it cannot be read. Both the glyph
 * widths and the image check come from it, so it is fetched once.
 */
async function operatorList(page: {
  getOperatorList: () => Promise<OperatorList>
}): Promise<OperatorList | null> {
  try {
    return await page.getOperatorList()
  } catch {
    // A page whose operators cannot be read is not worth failing extraction
    // over: its runs are covered whole and it does not get a vision pass.
    return null
  }
}

/**
 * Whether the page paints any image.
 *
 * A scanned page is one big image and a letterhead is a small one, and neither
 * is visible to a text detector: a signature, a face or a photographed ID card
 * is pixels. This is what decides which pages are worth the cost of a vision
 * pass, so it errs towards yes — an inline image, a mask and an XObject all
 * count.
 */
function pageHasImages(ops: Operators, list: OperatorList): boolean {
  const painters = new Set(
    [
      ops.paintImageXObject,
      ops.paintImageXObjectRepeat,
      ops.paintInlineImageXObject,
      ops.paintInlineImageXObjectGroup,
      ops.paintImageMaskXObject,
      ops.paintImageMaskXObjectRepeat,
      ops.paintImageMaskXObjectGroup,
      ops.paintJpegXObject,
    ].filter((op): op is number => typeof op === "number")
  )

  return list.fnArray.some((fn) => painters.has(fn))
}

/** Wraps the configured OCR session in the shape ocrPdfPages expects. */
async function startOcrRecognizer() {
  const session = await startOcr()
  return {
    recognize: (png: Buffer) => session.recognize(png),
    close: () => session.close(),
  }
}
