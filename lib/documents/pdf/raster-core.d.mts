import type { Canvas } from "@napi-rs/canvas"
import type { PDFPageProxy } from "pdfjs-dist"

/** How a drawn page is handed on. */
export type RasterOutput = "png" | "pgm" | "flate-rgb"

/** A box to remove, in PDF user-space units with a top-left origin. */
export type RasterBox = {
  x: number
  y: number
  width: number
  height: number
  label?: string
}

export type RenderRequest = {
  scale: number
  output: RasterOutput
  boxes?: RasterBox[]
  label?: string | null
}

export type EncodedPage = {
  data: Buffer
  /** Page size in PDF user-space units, i.e. the raster divided by `scale`. */
  width: number
  height: number
  pixelWidth: number
  pixelHeight: number
  scale: number
}

type CreateCanvas = (width: number, height: number) => Canvas

export const RENDER_SCALE: number
export const RANGE_CHUNK_BYTES: number

export function drawPage(
  page: PDFPageProxy,
  scale: number,
  createCanvas: CreateCanvas
): Promise<{ canvas: Canvas; width: number; height: number; scale: number }>

export function paintRedactions(
  canvas: Canvas,
  boxes: RasterBox[],
  label: string | null,
  scale: number
): void

export function greyPgm(canvas: Canvas): Buffer
export function flateRgb(canvas: Canvas): Buffer
export function encodeCanvas(canvas: Canvas, output: RasterOutput): Buffer

export function renderAndEncode(
  page: PDFPageProxy,
  request: RenderRequest,
  createCanvas: CreateCanvas
): Promise<EncodedPage>

export function documentOptions(assets: {
  standardFontDataUrl: string
  cMapUrl: string
}): {
  disableFontFace: boolean
  useSystemFonts: boolean
  standardFontDataUrl: string
  cMapUrl: string
  cMapPacked: boolean
}
