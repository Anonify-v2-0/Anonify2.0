import { mapWithConcurrency } from "@/lib/concurrency"
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

/**
 * Renders the given pages and hands each to `analyze` as soon as it is drawn,
 * with at most `concurrency` pages between the two at once (#173).
 *
 * The vision pass used to render every page first and then send them to the
 * model one after another, so a scanned document waited for twenty model
 * round trips in a row, holding twenty PNGs while it did. Here the model
 * calls overlap, and a page's PNG lives from its render until its call
 * returns, so at most `concurrency` of them are alive.
 *
 * Rendering itself takes turns. pdf.js renders on this thread whatever the
 * slots, so running two at once gains nothing, and one at a time keeps the
 * document proxy away from concurrent use it was never promised to survive.
 * The overlap that pays is page two rendering while page one's call is out.
 *
 * Results come back in the order of `pageNumbers`, whatever order they
 * finished in, so nothing downstream depends on timing. Pages outside the
 * document are left out.
 */
export async function analyzePagesForVision<R>(
  /**
   * The file's bytes, or ranged reads of it. By ranges, rendering the image
   * pages of a long document reads its index and those pages, not the file.
   */
  source: PdfSource,
  pageNumbers: number[],
  analyze: (image: RenderedPageImage) => Promise<R>,
  {
    concurrency = 1,
    scale = VISION_SCALE,
  }: { concurrency?: number; scale?: number } = {}
): Promise<{ page: number; result: R }[]> {
  if (pageNumbers.length === 0) return []

  const pdfjs = await loadPdfjsForRender()
  const { task, guard } = await openPdfDocument(pdfjs, source)
  let turn: Promise<unknown> = Promise.resolve()

  const run = async () => {
    const pdf = await task.promise
    const wanted = pageNumbers.filter(
      (pageNumber) => pageNumber >= 1 && pageNumber <= pdf.numPages
    )

    const draw = async (pageNumber: number): Promise<Buffer> => {
      const page = await pdf.getPage(pageNumber)
      try {
        const { canvas } = await renderPage(page, scale)
        return canvas.toBuffer("image/png")
      } finally {
        page.cleanup()
      }
    }

    return mapWithConcurrency(wanted, concurrency, async (pageNumber) => {
      const drawn = turn.then(() => draw(pageNumber))
      // The next render waits for this one whether it worked or not; a
      // failure is this task's to report.
      turn = drawn.catch(() => {})
      const png = await drawn
      return {
        page: pageNumber,
        result: await analyze({ page: pageNumber, png }),
      }
    })
  }

  try {
    return await guard(run())
  } finally {
    // The loading task owns the worker; destroying it is what releases both.
    await task.destroy()
  }
}

/** The pages as PNGs, rendered one at a time. */
export async function renderPagesForVision(
  source: PdfSource,
  pageNumbers: number[],
  scale = VISION_SCALE
): Promise<RenderedPageImage[]> {
  const rendered = await analyzePagesForVision(
    source,
    pageNumbers,
    async (image) => image,
    { scale }
  )
  return rendered.map(({ result }) => result)
}
