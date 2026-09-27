import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { createCanvas, type Canvas } from "@napi-rs/canvas"
import type { PDFPageProxy } from "pdfjs-dist"

import type { RangeSource } from "@/lib/storage/range-source"

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

/**
 * A directory pdf.js reads fonts or CMaps from.
 *
 * A filesystem path, not a `file://` URL. On Node, pdf.js appends the file name
 * and passes the string straight to `fs.readFile`, which treats `file:///…` as
 * a relative path and fails. Every non-embedded standard font then fell back to
 * a substitute face, and every PDF that relies on the bundled CMaps lost its
 * text. Forward slashes, because pdf.js insists on a trailing `/` and
 * `readFile` accepts them on Windows too.
 */
function assetUrl(...segments: string[]): string {
  return `${pdfjsAsset(...segments).split(path.sep).join("/")}/`
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

/** A PDF to open: its bytes, or ranged reads of it. */
export type PdfSource = Uint8Array | RangeSource

/**
 * The unit pdf.js asks for when it reads by ranges. Small enough that a page
 * costs roughly what it references; the range source underneath widens reads
 * to whole storage chunks and keeps the last few, so neighbouring requests do
 * not each become a round trip.
 */
const RANGE_CHUNK_BYTES = 64 * 1024

export type OpenedPdf = {
  task: ReturnType<PdfjsRuntime["getDocument"]>
  /**
   * Runs work against the document, failing it the moment a read under
   * pdf.js fails. pdf.js has no way to report one, and destroying the task
   * does not settle everything that was waiting on it.
   */
  guard: <T>(work: Promise<T>) => Promise<T>
}

/**
 * Opens a PDF for pdf.js, whole or by ranges.
 *
 * A PDF cannot be read front to back — its cross-reference table is at the
 * end — so reading it by ranges means pdf.js asks for the byte ranges it
 * needs, as it needs them, and only those are fetched and decrypted. With
 * auto-fetch and streaming off it asks for nothing else: rendering three
 * pages of a four-hundred-page document reads the index and those pages.
 *
 * pdf.js still keeps what it has fetched, in a buffer the length of the file
 * that fills in as it goes; what the ranges save is everything it never asks
 * for, and the second whole copy the byte path hands it.
 *
 * Its range transport has no way to report a failed read, and a request that
 * is never answered is a document that never finishes loading — and
 * destroying the task leaves some of what was waiting on it waiting. So the
 * failure is raced against the work instead: `guard` rejects with the read
 * that failed, and the task is destroyed to release the worker.
 */
export async function openPdfDocument(
  pdfjs: PdfjsRuntime,
  source: PdfSource
): Promise<OpenedPdf> {
  const common = {
    // Untrusted input: no font-face injection, no network font fetches.
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: pdfjs.standardFontDataUrl,
    cMapUrl: pdfjs.cMapUrl,
    cMapPacked: true,
  }

  if (source instanceof Uint8Array) {
    return {
      task: pdfjs.getDocument({ data: copyBytes(source), ...common }),
      guard: (work) => work,
    }
  }

  const ranged: RangeSource = source
  let task: OpenedPdf["task"] | null = null
  const size = ranged.size
  let fail: (error: unknown) => void = () => {}
  const failed = new Promise<never>((_, reject) => {
    fail = reject
  })
  // Nobody may be racing it yet when a read fails.
  failed.catch(() => {})

  class SealedRangeTransport extends pdfjs.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      ranged.range(begin, Math.min(end, size)).then(
        // Copied: pdf.js may transfer what it is handed, and a transferred
        // buffer is detached — here, a chunk the range cache is still holding.
        (chunk: Buffer) => this.onDataRange(begin, new Uint8Array(chunk)),
        (error: unknown) => {
          fail(error)
          void task?.destroy()
        }
      )
    }
  }

  const initial = new Uint8Array(
    await ranged.range(0, Math.min(size, RANGE_CHUNK_BYTES))
  )
  task = pdfjs.getDocument({
    ...common,
    // The length travels on the transport.
    range: new SealedRangeTransport(size, initial),
    rangeChunkSize: RANGE_CHUNK_BYTES,
    disableAutoFetch: true,
    disableStream: true,
  })
  return { task, guard: (work) => Promise.race([work, failed]) }
}
