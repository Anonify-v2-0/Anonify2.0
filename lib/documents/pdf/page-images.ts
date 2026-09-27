import {
  loadPdfjsForRender,
  openPdfDocument,
  renderPage,
  type PdfSource,
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
 * a model, and the coordinates come back on a 0-1000 grid, so resolution beyond
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
  /**
   * The file's bytes, or ranged reads of it. By ranges, rendering the image
   * pages of a long document reads its index and those pages, not the file.
   */
  source: PdfSource,
  pageNumbers: number[],
  scale = VISION_SCALE
): Promise<RenderedPageImage[]> {
  if (pageNumbers.length === 0) return []

  const pdfjs = await loadPdfjsForRender()
  const { task, guard } = await openPdfDocument(pdfjs, source)
  const rendered: RenderedPageImage[] = []

  const render = async () => {
    const pdf = await task.promise
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
  }

  try {
    await guard(render())
  } finally {
    // The loading task owns the worker; destroying it is what releases both.
    await task.destroy()
  }

  return rendered
}
