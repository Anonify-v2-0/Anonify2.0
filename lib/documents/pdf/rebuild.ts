import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"

import * as pdfLib from "pdf-lib"

import { rebuildPdf, type RebuildPlan } from "./rebuild-core.mjs"
import { renderThreadsEnabled } from "./render-pool"

/**
 * Where a redacted PDF is rebuilt (#245).
 *
 * #194 moved drawing pages off the event loop. What was left on it during an
 * export was pdf-lib rebuilding the file: parsing the source, copying the
 * untouched pages, writing the result. Measured with
 * `benchmarks/event-loop.ts --only export` on two CPUs, five pages redacted,
 * that held the loop for 57ms at most on a 150-page, 65 MiB scan, and 159ms
 * on a 361-page, 158 MiB one: past the 100ms at which it is worth moving.
 * Roughly a millisecond per MiB there, so 64 MiB leaves room for a slower CPU.
 *
 * So a source of `REBUILD_THREAD_BYTES` or more is rebuilt on a thread of its
 * own, and anything smaller here, where starting a thread and copying the
 * source to it would cost more than it saves. Both run rebuild-core.mjs, so
 * the file is the same either way. The export already holds a CPU slot for
 * the whole of its work (lib/redaction/export.ts), the rebuild included, so
 * the thread is counted as the main thread was.
 *
 * `ANONIFY_RENDER_THREADS=off` keeps this on the main thread too, as it keeps
 * the drawing there.
 */

/** Sources this large or larger are rebuilt on a thread. */
export const REBUILD_THREAD_BYTES = 64 * 1024 * 1024

/** Where to rebuild: decided by size, or forced, for tests and benchmarks. */
export type RebuildWhere = "auto" | "thread" | "main"

/** The rebuild thread stopped before it answered. Running the step again rebuilds anew. */
export class RebuildThreadLostError extends Error {
  constructor(cause?: unknown) {
    super("The thread rebuilding the exported PDF stopped", { cause })
    this.name = "RebuildThreadLostError"
  }
}

/**
 * The thread's entry, read at runtime from the working directory like the
 * render thread's; named in next.config.ts's `outputFileTracingIncludes`.
 */
export function rebuildThreadEntry(): string {
  return path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "lib",
    "documents",
    "pdf",
    "rebuild-thread.mjs"
  )
}

/**
 * pdf-lib's self-contained ES module build, as a URL the thread can import.
 * The bundler inlines pdf-lib for the main thread, so the package is resolved
 * from the app's root; null when this build does not have it.
 */
export function pdfLibModuleUrl(): string | null {
  try {
    const resolved = createRequire(
      path.join(/* turbopackIgnore: true */ process.cwd(), "package.json")
    ).resolve("pdf-lib/dist/pdf-lib.esm.min.js")
    return existsSync(resolved) ? pathToFileURL(resolved).href : null
  } catch {
    return null
  }
}

let warned = false

/** The thread's entry and pdf-lib, or null to rebuild here. */
function threadAssets(): { entry: string; pdfLibUrl: string } | null {
  const entry = rebuildThreadEntry()
  const pdfLibUrl = pdfLibModuleUrl()
  if (existsSync(entry) && pdfLibUrl) return { entry, pdfLibUrl }
  if (!warned) {
    warned = true
    console.warn(
      JSON.stringify({
        level: "warn",
        context: "pdf-rebuild",
        message:
          "lib/documents/pdf/rebuild-thread.mjs or pdf-lib's ES module build is not in this build, so large PDFs are rebuilt on the main thread. Add them to outputFileTracingIncludes.",
      })
    )
  }
  return null
}

/** Rebuilds `source` with its redacted pages replaced, here or on a thread. */
export async function rebuildRedactedPdf(
  source: Uint8Array,
  plan: RebuildPlan,
  where: RebuildWhere = "auto"
): Promise<Uint8Array> {
  const threaded =
    where === "thread" ||
    (where === "auto" &&
      source.byteLength >= REBUILD_THREAD_BYTES &&
      renderThreadsEnabled())
  const assets = threaded ? threadAssets() : null
  if (!assets) return rebuildPdf(pdfLib, source, plan)
  return onThread(assets, source, plan)
}

/** Bytes copied between turns of the event loop. */
const COPY_SLICE = 16 * 1024 * 1024

/**
 * A copy of `bytes` in a buffer of its own, made a slice at a time: copying
 * 190 MiB in one go is itself a pause of tens of milliseconds.
 */
async function copyInSlices(bytes: Uint8Array): Promise<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  for (let at = 0; at < bytes.byteLength; at += COPY_SLICE) {
    copy.set(bytes.subarray(at, at + COPY_SLICE), at)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return copy.buffer
}

async function onThread(
  assets: { entry: string; pdfLibUrl: string },
  source: Uint8Array,
  plan: RebuildPlan
): Promise<Uint8Array> {
  // Copied, not moved: the caller keeps the source for the next variant.
  // Each drawn page is copied too, so a buffer from a pool, or the canvas
  // library's own memory, is never what is transferred.
  const sourceCopy = await copyInSlices(source)
  const drawn = [...plan.drawn].map(
    ([index, page]) =>
      [index, { ...page, data: new Uint8Array(page.data) }] as const
  )
  const transfer = [sourceCopy, ...drawn.map(([, page]) => page.data.buffer)]

  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(assets.entry, {
      workerData: { pdfLibUrl: assets.pdfLibUrl },
    })
    let settled = false
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      finish()
      void worker.terminate()
    }
    worker.on(
      "message",
      (
        message:
          | { t: "ready" }
          | { t: "done"; data: ArrayBuffer }
          | { t: "fail"; message: string }
      ) => {
        if (message.t === "done")
          settle(() => resolve(new Uint8Array(message.data)))
        else if (message.t === "fail")
          settle(() => reject(new Error(message.message)))
      }
    )
    worker.on("error", (error) =>
      settle(() => reject(new RebuildThreadLostError(error)))
    )
    worker.on("exit", (code) =>
      settle(() =>
        reject(
          new RebuildThreadLostError(
            new Error(`rebuild thread exited with code ${code}`)
          )
        )
      )
    )
    worker.postMessage(
      {
        source: sourceCopy,
        redacted: [...plan.redacted],
        drawn,
        sanitizeMetadata: plan.sanitizeMetadata,
      },
      transfer as ArrayBuffer[]
    )
  })
}
