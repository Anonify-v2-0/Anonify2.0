import {
  copyBytes,
  loadPdfjsForRender,
  renderPage,
} from "@/lib/documents/pdf/render"

/**
 * Rasterizing PDF pages for the vision pass.
 *
 * A PDF's text layer says nothing about what its images contain. A signature, a
 * face, a photographed ID card, a screenshot of somebody's account page — all
 * of it is pixels, and the detectors and the language model between them read
 * only text. So a page that paints an image is rendered and looked at.
 *
 * Only those pages. Rendering a page costs CPU and every one sent costs tokens,
 * and a page of pure text has nothing here to find.
 */

/**
 * Rasterization scale for analysis. Lower than the redaction renderer's, which
 * has to produce output someone will read: this image is only ever looked at by
 * a model, and the coordinates come back normalized, so resolution beyond
 * legibility is paid for and discarded.
 */
export const VISION_SCALE = 1.5

/**
 * The most pages sent to the model for one document.
 *
 * A ceiling rather than a setting because the cost is per page and unbounded: a
 * 400-page scanned archive would otherwise quietly become 400 vision calls. The
 * pages are taken in order, so the front of the document — where letterheads,
 * photographs and signature blocks live — is what gets looked at.
 */
export const MAX_VISION_PAGES = 20

export type RenderedPageImage = {
  page: number
  png: Buffer
}

export async function renderPagesForVision(
  bytes: Uint8Array,
  pageNumbers: number[],
  scale = VISION_SCALE
): Promise<RenderedPageImage[]> {
  if (pageNumbers.length === 0) return []

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
  const rendered: RenderedPageImage[] = []

  try {
    for (const pageNumber of pageNumbers) {
      if (pageNumber < 1 || pageNumber > pdf.numPages) continue

      const page = await pdf.getPage(pageNumber)
      try {
        const { canvas } = await renderPage(page, scale)
        rendered.push({ page: pageNumber, png: canvas.toBuffer("image/png") })
      } finally {
        page.cleanup()
      }
    }
  } finally {
    // The loading task owns the worker; destroying it is what releases both.
    await task.destroy()
  }

  return rendered
}
