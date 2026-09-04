import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

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

const require = createRequire(import.meta.url)

/** Resolves a file shipped inside pdfjs-dist, wherever the package is linked. */
function pdfjsAsset(...segments: string[]): string {
  const root = path.dirname(require.resolve("pdfjs-dist/package.json"))
  return path.join(root, ...segments)
}

function assetUrl(...segments: string[]): string {
  return `${pathToFileURL(pdfjsAsset(...segments)).href}/`
}

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  // Node has no DOM worker, so pdf.js runs its worker module in-process. It
  // still needs to know where that module lives.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    pdfjsAsset("legacy", "build", "pdf.worker.mjs")
  ).href
  return pdfjs
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
  /** Pages with no usable embedded text; the OCR stage handles these. */
  ocrPages: number[]
}

export async function extractPdf(
  documentId: string,
  bytes: Uint8Array
): Promise<PdfExtraction> {
  const pdfjs = await loadPdfjs()

  const task = pdfjs.getDocument({
    data: bytes,
    // Untrusted input: no font-face injection, no network font fetches.
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: assetUrl("standard_fonts"),
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
  })

  const pdf = await task.promise
  const pages: NormalizedPage[] = []
  const ocrPages: number[] = []

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
      if (needsOcr) ocrPages.push(pageNumber)

      pages.push({
        number: pageNumber,
        width: viewport.width,
        height: viewport.height,
        text,
        spans: builder.spans,
        ocr: needsOcr ? true : undefined,
      })
    }
  } finally {
    await task.destroy()
  }

  return {
    document: {
      documentId,
      kind: "pdf",
      pages,
      metadata: { pageCount: pages.length },
    },
    ocrPages,
  }
}
