// @ts-check
import { deflateSync } from "node:zlib"

/**
 * Drawing a PDF page and encoding its raster: the one implementation, used on
 * the main thread and inside the render pool's threads alike (#194).
 *
 * Plain JavaScript on purpose. A worker thread's entry is a file Node loads
 * from disk, outside the bundler, so it cannot import the app's TypeScript or
 * its `@/` paths. Everything a render thread does lives here instead, and the
 * TypeScript side imports the same file (typed by raster-core.d.mts). So a
 * page drawn in a thread and a page drawn in-process are the same pixels,
 * which is what lets the pool be switched off without changing any output.
 *
 * Nothing here imports pdf.js or the canvas: each side hands in its own, as
 * loaded where it runs.
 */

/** Default rasterization scale. Enough detail for OCR and for a redaction. */
export const RENDER_SCALE = 2

const LABEL_FONT_RATIO = 0.6
const MIN_LABEL_HEIGHT = 8
/** Below this the glyphs stop being glyphs, and a smear is worse than nothing. */
const MIN_LABEL_PX = 6

/**
 * Leptonica's default luminance weights (L_RED_WEIGHT and the others), so the
 * grey Tesseract is given is the grey it would have computed (#189).
 */
const RED = 0.3
const GREEN = 0.5
const BLUE = 0.2

/**
 * Rasterizes one page onto a new canvas, on white.
 *
 * @param {import("pdfjs-dist").PDFPageProxy} page
 * @param {number} scale
 * @param {(width: number, height: number) => import("@napi-rs/canvas").Canvas} createCanvas
 */
export async function drawPage(page, scale, createCanvas) {
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height)
  )
  const context = canvas.getContext("2d")

  // Pages are transparent by default; OCR and redaction both want paper.
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)

  await page.render({
    // The napi canvas is API-compatible with the DOM one pdf.js expects.
    canvas: /** @type {any} */ (canvas),
    canvasContext: /** @type {any} */ (context),
    viewport,
  }).promise

  return {
    canvas,
    width: viewport.width / scale,
    height: viewport.height / scale,
    scale,
  }
}

/**
 * Paints a marker onto a strip, shrinking it until it fits.
 *
 * A strip is exactly as wide as the value it covers, and a surrogate is rarely
 * the same length as what it replaces, so "draw it at the obvious size" is not
 * an option. The type shrinks until the string fits or until it stops being
 * readable, and below that nothing is drawn: a strip with an illegible smear
 * on it reads as a rendering fault, while a plain strip reads as a redaction,
 * which is what it is. The vault still names what the strip stood for.
 *
 * @param {import("@napi-rs/canvas").SKRSContext2D} context
 * @param {string} marker
 * @param {{ x: number; y: number; width: number; height: number }} box
 */
function drawStripText(context, marker, box) {
  context.fillStyle = "#ffffff"
  context.textBaseline = "middle"

  let size = Math.max(MIN_LABEL_PX, box.height * LABEL_FONT_RATIO)

  for (;;) {
    context.font = `${size}px sans-serif`
    const metrics = context.measureText(marker)
    if (metrics.width < box.width) {
      context.fillText(
        marker,
        box.x + (box.width - metrics.width) / 2,
        box.y + box.height / 2
      )
      return
    }
    if (size <= MIN_LABEL_PX) return
    size = Math.max(MIN_LABEL_PX, size - 1)
  }
}

/**
 * Burns redaction boxes into a drawn page, in PDF user-space units with a
 * top-left origin.
 *
 * A box's own label is a surrogate and outranks the plan's marker: the marker
 * says something was removed, the surrogate says what stands in its place,
 * and only one of them can be painted in the space available.
 *
 * @param {import("@napi-rs/canvas").Canvas} canvas
 * @param {{ x: number; y: number; width: number; height: number; label?: string }[]} boxes
 * @param {string | null} label
 * @param {number} scale
 */
export function paintRedactions(canvas, boxes, label, scale) {
  const context = canvas.getContext("2d")
  for (const box of boxes) {
    const x = box.x * scale
    const y = box.y * scale
    const width = box.width * scale
    const height = box.height * scale

    context.fillStyle = "#000000"
    context.fillRect(x, y, width, height)

    const marker = box.label ?? label
    if (marker && height >= MIN_LABEL_HEIGHT) {
      drawStripText(context, marker, { x, y, width, height })
    }
  }
}

/**
 * The canvas as an 8-bit greyscale PGM (P5): what Tesseract reads best (#189).
 * Pages are drawn on white and never transparent, so alpha is ignored.
 *
 * @param {import("@napi-rs/canvas").Canvas} canvas
 */
export function greyPgm(canvas) {
  const { width, height } = canvas
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, "ascii")
  const out = Buffer.allocUnsafe(header.length + width * height)
  header.copy(out, 0)
  for (let from = 0, to = header.length; from < rgba.length; from += 4, to++) {
    out[to] =
      (RED * rgba[from] +
        GREEN * rgba[from + 1] +
        BLUE * rgba[from + 2] +
        0.5) |
      0
  }
  return out
}

/**
 * The canvas as raw RGB, deflated once: the stream of a PDF image XObject
 * (#174). The page was filled with white before anything was drawn, so every
 * pixel is opaque and dropping the alpha channel loses nothing.
 *
 * @param {import("@napi-rs/canvas").Canvas} canvas
 */
export function flateRgb(canvas) {
  const { width, height } = canvas
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data
  const rgb = Buffer.allocUnsafe(width * height * 3)
  for (let from = 0, to = 0; from < rgba.length; from += 4, to += 3) {
    rgb[to] = rgba[from]
    rgb[to + 1] = rgba[from + 1]
    rgb[to + 2] = rgba[from + 2]
  }
  return deflateSync(rgb)
}

/**
 * A drawn page in the form its consumer wants.
 *
 * @param {import("@napi-rs/canvas").Canvas} canvas
 * @param {"png" | "pgm" | "flate-rgb"} output
 */
export function encodeCanvas(canvas, output) {
  if (output === "pgm") return greyPgm(canvas)
  if (output === "flate-rgb") return flateRgb(canvas)
  return canvas.toBuffer("image/png")
}

/**
 * Draws a page, burns in any redactions, and encodes it: everything one
 * render task does, in one call.
 *
 * @param {import("pdfjs-dist").PDFPageProxy} page
 * @param {{ scale: number; output: "png" | "pgm" | "flate-rgb"; boxes?: { x: number; y: number; width: number; height: number; label?: string }[]; label?: string | null }} request
 * @param {(width: number, height: number) => import("@napi-rs/canvas").Canvas} createCanvas
 */
export async function renderAndEncode(page, request, createCanvas) {
  const drawn = await drawPage(page, request.scale, createCanvas)
  if (request.boxes?.length)
    paintRedactions(
      drawn.canvas,
      request.boxes,
      request.label ?? null,
      drawn.scale
    )
  return {
    data: encodeCanvas(drawn.canvas, request.output),
    width: drawn.width,
    height: drawn.height,
    pixelWidth: drawn.canvas.width,
    pixelHeight: drawn.canvas.height,
    scale: drawn.scale,
  }
}

/**
 * The options every pdf.js document is opened with. Untrusted input: no
 * font-face injection, no network font fetches.
 *
 * @param {{ standardFontDataUrl: string; cMapUrl: string }} assets
 */
export function documentOptions(assets) {
  return {
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: assets.standardFontDataUrl,
    cMapUrl: assets.cMapUrl,
    cMapPacked: true,
  }
}

/**
 * The unit pdf.js asks for when it reads by ranges. Small enough that a page
 * costs roughly what it references; the range source underneath widens reads
 * to whole storage chunks and keeps the last few.
 */
export const RANGE_CHUNK_BYTES = 64 * 1024
