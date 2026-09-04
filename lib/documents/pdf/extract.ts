import { startOcr } from "@/lib/documents/image/extract"
import {
  mergeOcrIntoPage,
  ocrPdfPages,
  type PageRecognizer,
} from "@/lib/documents/pdf/ocr"
import { copyBytes, loadPdfjsForRender } from "@/lib/documents/pdf/render"
import { TextStreamBuilder } from "@/lib/documents/shared/text"
import type {
  NormalizedDocument,
  NormalizedPage,
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

      const builder = new TextStreamBuilder()
      let index = 0

      for (const raw of content.items as PdfTextItem[]) {
        if (!("str" in raw)) continue
        const item = raw
        if (item.str.length > 0) {
          const [, , , scaleY, translateX, translateY] = item.transform
          const height = item.height && item.height > 0 ? item.height : Math.abs(scaleY)
          const width = item.width ?? 0

          builder.append(`p${pageNumber}s${index++}`, item.str, {
            boundingBox: {
              x: translateX,
              // PDF space is bottom-up; the canvas and the exporter both work
              // top-down, so flip once here and never again.
              y: viewport.height - translateY - height,
              width,
              height,
            },
            style: styleFrom(item.fontName, styles, height),
          })
        }

        if (item.hasEOL) {
          builder.pad("\n")
        } else if (item.str.length > 0 && !item.str.endsWith(" ")) {
          builder.pad(" ")
        }
      }

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

/** Wraps the tesseract worker in the shape ocrPdfPages expects. */
async function startOcrRecognizer() {
  const ocr = await startOcr()
  return {
    recognize: (png: Buffer) => ocr.recognize(png),
    close: () => ocr.close(),
  }
}
