// @ts-check
import { parentPort, workerData } from "node:worker_threads"

import {
  documentOptions,
  RANGE_CHUNK_BYTES,
  renderAndEncode,
} from "./raster-core.mjs"

/**
 * One render thread of the pool (#194). See lib/documents/pdf/render-pool.ts
 * for the other end of every message here.
 *
 * It holds pdf.js documents, one per session, and draws their pages when
 * asked. It never sees a key or a storage handle: the bytes pdf.js needs are
 * asked of the main thread a range at a time, and come back already
 * decrypted. A document's pages all come to the thread it was opened on, so
 * it is parsed once however many of its pages are drawn.
 *
 * Draws are taken one at a time, in the order they arrive. The pool sends a
 * thread one draw at a time anyway, so the order is the pool's.
 */

const port = parentPort
if (!port) throw new Error("render-thread.mjs runs only as a worker thread")

const { pdfjsUrl, canvasUrl, standardFontDataUrl, cMapUrl, workerSrc } =
  /** @type {{ pdfjsUrl: string; canvasUrl: string | null; standardFontDataUrl: string; cMapUrl: string; workerSrc: string }} */ (
    workerData
  )

const pdfjs = await import(pdfjsUrl)
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
// A CommonJS package: its exports arrive named, or on `default`.
const canvasModule = await import(canvasUrl ?? "@napi-rs/canvas")
const createCanvas =
  canvasModule.createCanvas ?? canvasModule.default.createCanvas
const options = documentOptions({ standardFontDataUrl, cMapUrl })

/**
 * @typedef {{
 *   task: any
 *   transport: any
 *   pending: Map<number, (error?: Error) => void>
 *   failed: Error | null
 *   failure: Promise<never>
 *   fail: (error: Error) => void
 * }} Session
 */

/** @type {Map<number, Session>} */
const sessions = new Map()
let nextRequest = 1

/**
 * @param {number} id
 * @param {number} size
 * @param {ArrayBuffer} initial
 */
function open(id, size, initial) {
  /** @type {Session} */
  /** @type {(error: Error) => void} */
  let fail = () => {}
  /** @type {Promise<never>} */
  const failure = new Promise((_, reject) => {
    fail = reject
  })
  // Nothing may be racing it yet when a read fails.
  failure.catch(() => {})
  const session = {
    task: null,
    transport: null,
    pending: new Map(),
    failed: null,
    failure,
    fail,
  }

  class ThreadRangeTransport extends pdfjs.PDFDataRangeTransport {
    /**
     * @param {number} begin
     * @param {number} end
     */
    requestDataRange(begin, end) {
      const request = nextRequest++
      session.pending.set(request, (error) => {
        if (error) {
          // pdf.js has no way to hear that a read failed, and destroying the
          // task does not settle what was waiting on it, so the work is raced
          // against the failure instead, as render.ts does in-process.
          session.failed = error
          session.fail(error)
          void session.task?.destroy()
        }
      })
      port?.postMessage({
        t: "need",
        s: id,
        r: request,
        begin,
        end: Math.min(end, size),
      })
    }
  }

  // The answers to `need` are routed back to this transport.
  session.transport = new ThreadRangeTransport(size, new Uint8Array(initial))
  session.task = pdfjs.getDocument({
    ...options,
    range: session.transport,
    rangeChunkSize: RANGE_CHUNK_BYTES,
    disableAutoFetch: true,
    disableStream: true,
  })
  sessions.set(id, session)

  Promise.race([session.task.promise, session.failure]).then(
    (/** @type {any} */ pdf) =>
      port?.postMessage({ t: "opened", s: id, pages: pdf.numPages }),
    (/** @type {Error} */ error) =>
      port?.postMessage({
        t: "open-fail",
        s: id,
        message: (session.failed ?? error).message,
      })
  )
}

/**
 * @param {{ id: number; s: number; page: number; scale: number; output: "png" | "pgm" | "flate-rgb"; boxes?: any[]; label?: string | null }} message
 */
async function draw(message) {
  const session = sessions.get(message.s)
  if (!session) throw new Error(`no open document ${message.s} on this thread`)
  const guard = (/** @type {Promise<any>} */ work) =>
    Promise.race([work, session.failure])
  const pdf = await guard(session.task.promise)
  const page = await guard(pdf.getPage(message.page))
  try {
    return await guard(renderAndEncode(page, message, createCanvas))
  } finally {
    page.cleanup()
  }
}

/** One draw at a time, in arrival order. */
let turn = Promise.resolve()

port.on("message", (/** @type {any} */ message) => {
  switch (message.t) {
    case "open":
      open(message.s, message.size, message.initial)
      break
    case "range": {
      const session = sessions.get(message.s)
      if (!session) break
      session.pending.delete(message.r)
      session.transport.onDataRange(message.begin, new Uint8Array(message.data))
      break
    }
    case "range-fail": {
      const session = sessions.get(message.s)
      const settle = session?.pending.get(message.r)
      session?.pending.delete(message.r)
      settle?.(new Error(message.message))
      break
    }
    case "draw":
      turn = turn.then(async () => {
        try {
          const page = await draw(message)
          const reply = {
            t: "drawn",
            id: message.id,
            data: page.data.buffer,
            width: page.width,
            height: page.height,
            pixelWidth: page.pixelWidth,
            pixelHeight: page.pixelHeight,
            scale: page.scale,
          }
          // The raster moves to the main thread rather than being copied,
          // when it can: a buffer that is all its own memory, and not memory
          // the canvas library allocated, which cannot be transferred.
          const whole =
            page.data.byteOffset === 0 &&
            page.data.byteLength === page.data.buffer.byteLength
          let moved = false
          if (whole) {
            try {
              port.postMessage(reply, [page.data.buffer])
              moved = true
            } catch {
              // DataCloneError: external memory. Copied below.
            }
          }
          if (!moved) {
            const copy = page.data.buffer.slice(
              page.data.byteOffset,
              page.data.byteOffset + page.data.byteLength
            )
            port.postMessage({ ...reply, data: copy }, [copy])
          }
        } catch (error) {
          const session = sessions.get(message.s)
          port.postMessage({
            t: "draw-fail",
            id: message.id,
            message: (session?.failed ?? /** @type {Error} */ (error)).message,
          })
        }
      })
      break
    case "close": {
      const session = sessions.get(message.s)
      sessions.delete(message.s)
      void session?.task.destroy()
      break
    }
  }
})

port.postMessage({ t: "ready" })
