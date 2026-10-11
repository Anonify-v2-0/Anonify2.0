import { createCanvas } from "@napi-rs/canvas"
import type { PDFDocumentProxy } from "pdfjs-dist"

import { withCpuSlot } from "@/lib/runtime/cpu-slots"
import { bufferRangeSource } from "@/lib/storage/range-source"

import {
  renderAndEncode,
  type EncodedPage,
  type RenderRequest,
} from "./raster-core.mjs"
import {
  loadPdfjsForRender,
  openPdfDocument,
  renderThreadAssets,
  type PdfSource,
} from "./render"
import { canvasModuleUrl, renderPool } from "./render-pool"

export type { EncodedPage, RenderRequest } from "./raster-core.mjs"

/**
 * Drawing a document's pages, wherever that happens (#194).
 *
 * OCR, the vision pass and export each open a renderer for the document
 * they work on, ask it for pages, and close it. Behind it is a session on
 * the render pool's threads, or, with the pool off or missing from the
 * build, pdf.js on this thread as before. Either way a page is drawn by
 * raster-core.mjs and comes back encoded, and each draw takes a CPU slot
 * (#181), so the slots go on counting what they counted.
 */
export type PageRenderer = {
  readonly pageCount: number
  /** Whether pages are drawn on the pool's threads. */
  readonly threaded: boolean
  draw(page: number, request: RenderRequest): Promise<EncodedPage>
  close(): Promise<void>
}

/**
 * Opens `source` for drawing. `open`, when the caller already has the
 * document open on this thread (extraction does), is used for in-process
 * drawing rather than parsing the file again; with the pool, the thread parses
 * its own copy either way.
 */
export async function openPageRenderer(
  source: PdfSource,
  open?: PDFDocumentProxy
): Promise<PageRenderer> {
  const pool = renderPool(() => ({
    ...renderThreadAssets(),
    canvasUrl: canvasModuleUrl(),
  }))
  if (pool) {
    const session = pool.open(
      source instanceof Uint8Array ? bufferRangeSource(source) : source
    )
    try {
      const pageCount = await session.open()
      return {
        pageCount,
        threaded: true,
        draw: (page, request) => withCpuSlot(() => session.draw(page, request)),
        close: async () => session.close(),
      }
    } catch (error) {
      session.close()
      throw error
    }
  }
  return inProcess(source, open)
}

async function inProcess(
  source: PdfSource,
  open?: PDFDocumentProxy
): Promise<PageRenderer> {
  if (open) return inProcessRenderer(open)
  const opened = await openPdfDocument(await loadPdfjsForRender(), source)
  try {
    const pdf = await opened.guard(opened.task.promise)
    return inProcessRenderer(pdf, opened.guard, () => opened.task.destroy())
  } catch (error) {
    await opened.task.destroy()
    throw error
  }
}

/**
 * Pages of a document already open on this thread, drawn here. The caller
 * keeps the document; `release`, when given, is what closing does.
 */
export function inProcessRenderer(
  document: PDFDocumentProxy,
  guard: <T>(work: Promise<T>) => Promise<T> = (work) => work,
  release: () => Promise<void> = async () => {}
): PageRenderer {
  // Drawing takes turns: pdf.js draws on this thread whatever the
  // concurrency, and one document proxy is not drawn from twice at once.
  let turn: Promise<unknown> = Promise.resolve()

  return {
    pageCount: document.numPages,
    threaded: false,
    draw(pageNumber, request) {
      const drawn = turn.then(() =>
        withCpuSlot(async () => {
          const page = await guard(document.getPage(pageNumber))
          try {
            return await guard(renderAndEncode(page, request, createCanvas))
          } finally {
            page.cleanup()
          }
        })
      )
      turn = drawn.catch(() => {})
      return drawn
    },
    close: release,
  }
}
