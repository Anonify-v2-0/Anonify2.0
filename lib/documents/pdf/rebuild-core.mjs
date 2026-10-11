// @ts-check

/**
 * Rebuilding a redacted PDF from its source and its drawn pages (#174, #245).
 *
 * The one copy of this, run on the main thread for most exports and on a
 * rebuild thread (rebuild-thread.mjs) for very large ones, so the two cannot
 * drift apart: the same pdf-lib calls in the same order give the same file.
 * pdf-lib is handed in rather than imported, because the thread loads it by
 * URL and the main thread through the bundler.
 *
 * Every untouched page is copied in one call (#174): pdf-lib clones what a
 * page refers to once per call, so copying a page at a time cloned a font
 * shared by every page once per page. A redacted page becomes its drawn
 * raster, already deflated as raw RGB on a render thread (#194), as an image
 * XObject.
 */

/**
 * @typedef {typeof import("pdf-lib")} PdfLib
 * @typedef {{
 *   data: Uint8Array
 *   width: number
 *   height: number
 *   pixelWidth: number
 *   pixelHeight: number
 * }} DrawnPage
 */

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
 *
 * @param {PdfLib} lib
 * @param {import("pdf-lib").PDFDocument} output
 * @param {DrawnPage} drawn
 */
function addRasterPage(lib, output, drawn) {
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
    lib.pushGraphicsState(),
    lib.concatTransformationMatrix(width, 0, 0, height, 0, 0),
    lib.drawObject(name),
    lib.popGraphicsState()
  )
}

/**
 * Clears authorship and tooling fingerprints from the exported document.
 *
 * @param {import("pdf-lib").PDFDocument} pdf
 */
export function sanitizeMetadata(pdf) {
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

/**
 * The exported file: `source` with each page in `redacted` (zero-based)
 * replaced by its drawing in `drawn`.
 *
 * A page meant to be redacted with no drawing fails the export rather than
 * being copied through, which would put the value back in the file.
 *
 * @param {PdfLib} lib
 * @param {Uint8Array} source
 * @param {{ redacted: Set<number>, drawn: Map<number, DrawnPage>, sanitizeMetadata: boolean }} plan
 * @returns {Promise<Uint8Array>}
 */
export async function rebuildPdf(lib, source, plan) {
  const document = await lib.PDFDocument.load(source, {
    ignoreEncryption: true,
  })
  const output = await lib.PDFDocument.create()
  const pageCount = document.getPageCount()

  const untouched = []
  for (let index = 0; index < pageCount; index++)
    if (!plan.redacted.has(index)) untouched.push(index)
  /** @type {Map<number, import("pdf-lib").PDFPage>} */
  const copies = new Map()
  if (untouched.length > 0) {
    const copied = await output.copyPages(document, untouched)
    untouched.forEach((index, at) => copies.set(index, copied[at]))
  }

  for (let index = 0; index < pageCount; index++) {
    const copy = copies.get(index)
    if (copy) {
      output.addPage(copy)
      continue
    }
    const drawn = plan.drawn.get(index)
    if (!drawn)
      throw new Error(
        `Page ${index + 1} is to be redacted but was not drawn, so it cannot be exported`
      )
    addRasterPage(lib, output, drawn)
  }

  if (plan.sanitizeMetadata) sanitizeMetadata(output)

  return output.save({ useObjectStreams: true })
}
