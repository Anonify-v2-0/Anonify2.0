import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { createCanvas, type Canvas } from "@napi-rs/canvas"
import type { PDFPageProxy } from "pdfjs-dist"

/**
 * Shared pdf.js loading for the server.
 *
 * Font and CMap data live inside the installed package, so the paths are
 * resolved from the package itself rather than assumed relative to the working
 * directory — the bundle layout on a serverless deployment is not the repo's.
 */

const require = createRequire(import.meta.url)

/** A file that must exist under the package root, used to validate a candidate. */
const MARKER = path.join("legacy", "build", "pdf.worker.mjs")

let cachedRoot: string | null = null

/**
 * Locates the installed pdfjs-dist.
 *
 * `require.resolve` is the obvious way and it is not enough: inside a bundled
 * server build the specifier is rewritten to a synthetic `[externals]` path, so
 * the result points nowhere and pdf.js fails to start its worker — which is how
 * PDF processing can pass every direct test and still fail in the pipeline.
 *
 * Each candidate is therefore checked against a file that has to be there.
 */
function pdfjsRoot(): string {
  if (cachedRoot) return cachedRoot

  const candidates: string[] = []

  try {
    candidates.push(path.dirname(require.resolve("pdfjs-dist/package.json")))
  } catch {
    // Bundled builds may not resolve it at all; the paths below still can.
  }

  candidates.push(path.join(process.cwd(), "node_modules", "pdfjs-dist"))

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, MARKER))) {
      cachedRoot = candidate
      return candidate
    }
  }

  throw new Error(
    `Could not locate pdfjs-dist. Looked in: ${candidates.join(", ")}`
  )
}

function pdfjsAsset(...segments: string[]): string {
  return path.join(pdfjsRoot(), ...segments)
}

function assetUrl(...segments: string[]): string {
  return `${pathToFileURL(pdfjsAsset(...segments)).href}/`
}

export type PdfjsRuntime = Awaited<
  typeof import("pdfjs-dist/legacy/build/pdf.mjs")
> & {
  standardFontDataUrl: string
  cMapUrl: string
}

/**
 * pdf.js transfers (and thereby detaches) the buffer it is handed, so every
 * caller passes its own copy — otherwise extracting a document would make the
 * same bytes unreadable for the exporter that runs next.
 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

/** Default rasterization scale. Enough detail for OCR and for a redaction. */
export const RENDER_SCALE = 2

export type RenderedPage = {
  canvas: Canvas
  /** Page size in PDF user-space units, i.e. the raster divided by `scale`. */
  width: number
  height: number
  scale: number
}

/**
 * Rasterizes one page onto a canvas.
 *
 * Shared by redaction, which paints boxes onto the pixels before rebuilding the
 * page, and by OCR, which reads them. Both need the same geometry, so both go
 * through here rather than each growing their own copy of the transform.
 */
export async function renderPage(
  page: PDFPageProxy,
  scale = RENDER_SCALE
): Promise<RenderedPage> {
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
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise

  return {
    canvas,
    width: viewport.width / scale,
    height: viewport.height / scale,
    scale,
  }
}

export async function loadPdfjsForRender(): Promise<PdfjsRuntime> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")

  // Node has no DOM worker, so pdf.js runs its worker module in-process. It
  // still needs to know where that module lives.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    pdfjsAsset("legacy", "build", "pdf.worker.mjs")
  ).href

  // The module namespace object is frozen, so the asset paths travel alongside
  // it rather than being attached to it.
  return {
    ...pdfjs,
    standardFontDataUrl: assetUrl("standard_fonts"),
    cMapUrl: assetUrl("cmaps"),
  } as PdfjsRuntime
}
