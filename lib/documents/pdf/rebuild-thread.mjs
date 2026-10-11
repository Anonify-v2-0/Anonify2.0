// @ts-check
import { parentPort, workerData } from "node:worker_threads"

import { rebuildPdf } from "./rebuild-core.mjs"

/**
 * One rebuild of a very large redacted PDF, off the main thread (#245). See
 * lib/documents/pdf/rebuild.ts for the other end.
 *
 * pdf-lib parsing the source, copying its untouched pages and writing the
 * result held the event loop for 159ms on a 361-page, 158 MiB scan. Here it
 * holds this thread instead. One rebuild per thread, then it exits: files this
 * large are rare, and a thread that lives only as long as its file holds no
 * memory after it.
 *
 * It sees only bytes: the source, already decrypted on the main thread, and
 * the drawn pages. No key and no storage handle.
 */

const port = parentPort
if (!port) throw new Error("rebuild-thread.mjs runs only as a worker thread")

const { pdfLibUrl } = /** @type {{ pdfLibUrl: string }} */ (workerData)
/** @type {typeof import("pdf-lib")} */
const lib = await import(pdfLibUrl)

port.once(
  "message",
  /**
   * @param {{
   *   source: ArrayBuffer
   *   redacted: number[]
   *   drawn: [number, import("./rebuild-core.mjs").DrawnPage][]
   *   sanitizeMetadata: boolean
   * }} message
   */
  async (message) => {
    try {
      const bytes = await rebuildPdf(lib, new Uint8Array(message.source), {
        redacted: new Set(message.redacted),
        drawn: new Map(message.drawn),
        sanitizeMetadata: message.sanitizeMetadata,
      })
      // pdf-lib's output is its own buffer, so it moves rather than copies
      // when it is the whole of one; otherwise it is copied once.
      const data =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.slice().buffer
      port.postMessage({ t: "done", data }, [/** @type {ArrayBuffer} */ (data)])
    } catch (error) {
      port.postMessage({
        t: "fail",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
)

port.postMessage({ t: "ready" })
