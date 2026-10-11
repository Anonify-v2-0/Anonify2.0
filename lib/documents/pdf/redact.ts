import { openPageRenderer } from "@/lib/documents/pdf/page-renderer"
import {
  copyBytes,
  loadPdfjsForRender,
  RENDER_SCALE,
} from "@/lib/documents/pdf/render"
import type { DrawnPage } from "@/lib/documents/pdf/rebuild-core.mjs"
import {
  rebuildRedactedPdf,
  type RebuildWhere,
} from "@/lib/documents/pdf/rebuild"
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
  /** Where to rebuild the file; by its size unless forced (#245). */
  rebuild?: RebuildWhere
}

export async function redactPdf(
  bytes: Uint8Array,
  plan: PdfRedactionPlan
): Promise<Uint8Array> {
  const scale = plan.scale ?? RENDER_SCALE
  // Zero-based, as pdf-lib counts.
  const redacted = new Set(
    [...plan.boxesByPage]
      .filter(([, boxes]) => boxes.length > 0)
      .map(([page]) => page - 1)
  )
  const drawn = new Map<number, DrawnPage>()

  // The redacted pages are drawn first, then the file is rebuilt from them
  // and the source in one go (rebuild-core.mjs), on this thread or, for a
  // very large file, on one of its own (#245). pdf.js reads by ranges over
  // the bytes already here rather than a copy of the whole file (#187), on a
  // render thread (#194) as they are asked for. Nothing to draw, nothing
  // opened.
  if (redacted.size > 0) {
    const renderer = await openPageRenderer(bufferRangeSource(bytes))
    try {
      // A page past the end is not drawn; if pdf-lib counts it anyway, the
      // rebuild refuses rather than copying it through.
      const pages = [...redacted]
        .filter((index) => index < renderer.pageCount)
        .sort((a, b) => a - b)
      for (const index of pages) {
        drawn.set(
          index,
          await renderer.draw(index + 1, {
            scale,
            output: "flate-rgb",
            boxes: plan.boxesByPage.get(index + 1) ?? [],
            label: plan.label,
          })
        )
        plan.onPage?.(drawn.size, pages.length)
      }
    } finally {
      await renderer.close()
    }
  }

  return rebuildRedactedPdf(
    bytes,
    { redacted, drawn, sanitizeMetadata: plan.sanitizeMetadata },
    plan.rebuild
  )
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
