import type { Canvas } from "@napi-rs/canvas"

/**
 * How a rendered page is handed to the OCR engine (#189).
 *
 * It used to be a PNG: the page drawn at 2x, compressed with zlib (the costly
 * part, at that size), then decompressed again by the engine. Tesseract reads
 * a page through Leptonica, which reads PNM natively, and a greyscale PGM is a
 * dozen bytes of header and one byte per pixel: no compression to pay for in
 * either direction, and a third of the raw RGB.
 *
 * Grey is what Tesseract reads anyway. It converts a colour page with
 * Leptonica's weights (0.3 red, 0.5 green, 0.2 blue, rounded), and the same
 * weights are used here, so the grey it would have computed is the grey it is
 * given. BMP was measured and refused: tesseract.js re-encodes every BMP in
 * JavaScript before Leptonica sees it.
 *
 * A remote engine gets what it accepts: Mistral takes PNG or JPEG.
 */

export type RasterFormat = "png" | "pgm"

/** Leptonica's default luminance weights (L_RED_WEIGHT and the others). */
const RED = 0.3
const GREEN = 0.5
const BLUE = 0.2

/** The canvas as an 8-bit greyscale PGM (P5). */
export function greyPgm(canvas: Canvas): Buffer {
  const { width, height } = canvas
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, "ascii")
  const out = Buffer.allocUnsafe(header.length + width * height)
  header.copy(out, 0)
  // Pages are drawn on white and never transparent, so alpha is ignored.
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

/** A rendered page, in the format its engine reads best. */
export function encodeRaster(canvas: Canvas, format: RasterFormat): Buffer {
  return format === "pgm" ? greyPgm(canvas) : canvas.toBuffer("image/png")
}
