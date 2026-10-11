import type { Canvas } from "@napi-rs/canvas"

import { encodeCanvas } from "@/lib/documents/pdf/raster-core.mjs"

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

// One implementation, shared with the render threads (#194).
export { greyPgm } from "@/lib/documents/pdf/raster-core.mjs"

/** A rendered page, in the format its engine reads best. */
export function encodeRaster(canvas: Canvas, format: RasterFormat): Buffer {
  return encodeCanvas(canvas, format)
}
