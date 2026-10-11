import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"

import { cpuConcurrency } from "@/lib/runtime/capacity"
import type { RangeSource } from "@/lib/storage/range-source"

import {
  RANGE_CHUNK_BYTES,
  type EncodedPage,
  type RenderRequest,
} from "./raster-core.mjs"

/**
 * PDF pages drawn on worker threads, not on the event loop (#194).
 *
 * pdf.js on Node runs its "worker" in-process, so every page it drew, and
 * every PNG, PGM or deflated raster made of it, ran on the thread that also
 * answers HTTP. A forty-page scan made the workspace stutter for everyone on
 * an `all` container, and a busy worker could miss its own readiness probe.
 * Here a pool of threads does the drawing and encoding, and the main thread
 * only hands out pages and passes bytes.
 *
 * - **Sessions.** A document is opened on one thread and all of its pages go
 *   there, so it is parsed once per session, as it was in-process. pdf.js
 *   state cannot cross threads, so this is also the only way.
 * - **Keys stay here.** A thread never holds a key or a storage handle. Its
 *   pdf.js asks for byte ranges; this thread reads them from the document's
 *   own range source, decrypting as it already does, and sends back
 *   plaintext. See docs/security-internals.md.
 * - **Bounded twice.** At most `cpuConcurrency()` threads (#181), and every
 *   draw still takes a CPU slot, so the slots count the same work they did.
 * - **Failure.** A thread that dies mid-page is replaced. The page it was
 *   drawing fails with `RenderThreadLostError`, which is retryable; pages
 *   queued behind it move to a new thread. A page that takes longer than
 *   `ANONIFY_RENDER_TIMEOUT_MS` has its thread terminated, the only way to
 *   stop pdf.js mid-draw, and fails with `RenderTimeoutError`, which is a
 *   verdict on the file, not weather. Either way the process and every other
 *   document carry on, where in-process the whole server would have stalled.
 *
 * `ANONIFY_RENDER_THREADS=off` draws in-process as before: the same code
 * (raster-core.mjs), the same pixels.
 */

type Env = Record<string, string | undefined>

export const RENDER_THREADS_ENV = "ANONIFY_RENDER_THREADS"
export const RENDER_TIMEOUT_ENV = "ANONIFY_RENDER_TIMEOUT_MS"
export const DEFAULT_RENDER_TIMEOUT_MS = 120_000

/** `ANONIFY_RENDER_THREADS`: on (the default) or off. Malformed throws. */
export function renderThreadsEnabled(env: Env = process.env): boolean {
  const raw = env[RENDER_THREADS_ENV]?.trim().toLowerCase()
  if (!raw || raw === "on") return true
  if (raw === "off") return false
  throw new Error(`${RENDER_THREADS_ENV} must be "on" or "off"`)
}

/** `ANONIFY_RENDER_TIMEOUT_MS` (1000–3600000), per page. Malformed throws. */
export function renderTimeoutMs(env: Env = process.env): number {
  const raw = env[RENDER_TIMEOUT_ENV]?.trim()
  if (!raw) return DEFAULT_RENDER_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1000 || value > 3_600_000)
    throw new Error(
      `${RENDER_TIMEOUT_ENV} must be a whole number of milliseconds from 1000 to 3600000`
    )
  return value
}

/**
 * A page that took longer than the limit. Worded so the failure classifier
 * reads it as `too-complex` (lib/workflows/failure.ts): the same page takes
 * as long next time.
 */
export class RenderTimeoutError extends Error {
  constructor(page: number, limitMs: number) {
    super(
      `Page ${page} exceeds the rendering limit of ${Math.round(limitMs / 1000)} seconds`
    )
    this.name = "RenderTimeoutError"
  }
}

/** The thread drawing a page stopped. Running the step again draws it anew. */
export class RenderThreadLostError extends Error {
  constructor(page: number | null, cause?: unknown) {
    super(
      page === null
        ? "The render thread stopped while opening a document"
        : `The render thread stopped while drawing page ${page}`,
      { cause }
    )
    this.name = "RenderThreadLostError"
  }
}

/** Threads with nothing open are stopped after this, and started again on use. */
const IDLE_MS = 5 * 60_000

/** Where a thread loads pdf.js, the canvas and its own entry from. */
export type ThreadAssets = {
  entry: string
  pdfjsUrl: string
  workerSrc: string
  canvasUrl: string | null
  standardFontDataUrl: string
  cMapUrl: string
}

/**
 * The thread's entry, as a path. Read at runtime from the working directory,
 * which is the app's root in the image, on Vercel and in development.
 * Ignored by Turbopack's tracing, like render.ts's pdf.js assets: the file is
 * named in next.config.ts's `outputFileTracingIncludes` instead.
 */
export function threadEntry(): string {
  return path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "lib",
    "documents",
    "pdf",
    "render-thread.mjs"
  )
}

/**
 * The canvas package as a URL a thread can import, resolved from the app's
 * root. `require.resolve` from inside a bundle answers with a synthetic path,
 * so the root is asked instead; null leaves the thread to import it by name.
 */
export function canvasModuleUrl(): string | null {
  try {
    const resolved = createRequire(
      path.join(/* turbopackIgnore: true */ process.cwd(), "package.json")
    ).resolve("@napi-rs/canvas")
    return existsSync(resolved) ? pathToFileURL(resolved).href : null
  } catch {
    return null
  }
}

type Draw = {
  /** Times it was sent again after the thread opening its document died. */
  reopened: number
  session: RenderSession
  page: number
  request: RenderRequest
  resolve: (page: EncodedPage) => void
  reject: (error: unknown) => void
}

type Drawn = {
  t: "drawn"
  id: number
  data: ArrayBuffer
  width: number
  height: number
  pixelWidth: number
  pixelHeight: number
  scale: number
}

type FromThread =
  | { t: "ready" }
  | { t: "opened"; s: number; pages: number }
  | { t: "open-fail"; s: number; message: string }
  | { t: "need"; s: number; r: number; begin: number; end: number }
  | Drawn
  | { t: "draw-fail"; id: number; message: string }

let nextSession = 1
let nextDraw = 1

class RenderThread {
  readonly worker: Worker
  readonly sessions = new Set<RenderSession>()
  private readonly queue: Draw[] = []
  private current: { id: number; draw: Draw; timer: NodeJS.Timeout } | null =
    null
  private readonly opening = new Map<
    number,
    { resolve: (pages: number) => void; reject: (error: Error) => void }
  >()
  dead = false
  private idleTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly pool: RenderPool,
    assets: ThreadAssets
  ) {
    this.worker = new Worker(assets.entry, {
      workerData: {
        pdfjsUrl: assets.pdfjsUrl,
        workerSrc: assets.workerSrc,
        canvasUrl: assets.canvasUrl,
        standardFontDataUrl: assets.standardFontDataUrl,
        cMapUrl: assets.cMapUrl,
      },
    })
    // Held only while it has work: a pool with nothing to do must not keep a
    // script or a test alive, and one drawing a page must.
    this.worker.unref()
    this.worker.on("message", (message: FromThread) => this.receive(message))
    this.worker.on("error", (error) => this.lost(error))
    this.worker.on("exit", (code) => {
      if (!this.dead)
        this.lost(new Error(`render thread exited with code ${code}`))
    })
  }

  get load(): number {
    return this.sessions.size + this.queue.length + (this.current ? 1 : 0)
  }

  private busy(): void {
    if (!this.dead) this.worker.ref()
  }

  open(session: RenderSession, size: number, initial: Buffer): Promise<number> {
    clearTimeout(this.idleTimer)
    this.sessions.add(session)
    this.busy()
    const data = new Uint8Array(initial).buffer
    return new Promise<number>((resolve, reject) => {
      this.opening.set(session.id, { resolve, reject })
      this.worker.postMessage(
        { t: "open", s: session.id, size, initial: data },
        [data]
      )
    })
  }

  close(session: RenderSession): void {
    if (!this.sessions.delete(session) || this.dead) return
    this.worker.postMessage({ t: "close", s: session.id })
    this.maybeIdle()
  }

  enqueue(draw: Draw): void {
    clearTimeout(this.idleTimer)
    this.busy()
    this.queue.push(draw)
    this.next()
  }

  private next(): void {
    if (this.current || this.dead) return
    const draw = this.queue.shift()
    if (!draw) return
    const id = nextDraw++
    const timer = setTimeout(() => this.timedOut(), this.pool.timeoutMs)
    this.current = { id, draw, timer }
    this.worker.postMessage({
      t: "draw",
      id,
      s: draw.session.id,
      page: draw.page,
      scale: draw.request.scale,
      output: draw.request.output,
      boxes: draw.request.boxes,
      label: draw.request.label ?? null,
    })
  }

  private receive(message: FromThread): void {
    switch (message.t) {
      case "ready":
        break
      case "opened":
        this.opening.get(message.s)?.resolve(message.pages)
        this.opening.delete(message.s)
        this.maybeIdle()
        break
      case "open-fail":
        this.opening
          .get(message.s)
          ?.reject(this.failureOf(message.s, message.message))
        this.opening.delete(message.s)
        this.maybeIdle()
        break
      case "need":
        this.serve(message)
        break
      case "drawn":
      case "draw-fail": {
        const current = this.current
        if (!current || current.id !== message.id) return
        clearTimeout(current.timer)
        this.current = null
        if (message.t === "drawn") {
          current.draw.resolve({
            data: Buffer.from(message.data),
            width: message.width,
            height: message.height,
            pixelWidth: message.pixelWidth,
            pixelHeight: message.pixelHeight,
            scale: message.scale,
          })
        } else {
          current.draw.reject(
            this.failureOf(current.draw.session.id, message.message)
          )
        }
        this.next()
        this.maybeIdle()
        break
      }
    }
  }

  /** The read that failed under pdf.js, if one did; it says more than pdf.js does. */
  private failureOf(sessionId: number, message: string): Error {
    const session = [...this.sessions].find((entry) => entry.id === sessionId)
    return session?.readFailure ?? new Error(message)
  }

  /** A range pdf.js asked for, read and decrypted here, sent as plaintext. */
  private serve(message: {
    s: number
    r: number
    begin: number
    end: number
  }): void {
    const session = [...this.sessions].find((entry) => entry.id === message.s)
    if (!session) return
    session.source.range(message.begin, message.end).then(
      (chunk) => {
        if (this.dead) return
        // Copied: the range source may be keeping this chunk.
        const data = new Uint8Array(chunk).buffer
        this.worker.postMessage(
          {
            t: "range",
            s: message.s,
            r: message.r,
            begin: message.begin,
            data,
          },
          [data]
        )
      },
      (error: unknown) => {
        session.readFailure ??=
          error instanceof Error ? error : new Error(String(error))
        if (!this.dead)
          this.worker.postMessage({
            t: "range-fail",
            s: message.s,
            r: message.r,
            message: session.readFailure.message,
          })
      }
    )
  }

  private timedOut(): void {
    const current = this.current
    if (!current) return
    this.current = null
    current.draw.reject(
      new RenderTimeoutError(current.draw.page, this.pool.timeoutMs)
    )
    // pdf.js cannot be interrupted mid-draw; only the thread can be stopped.
    this.lost(null)
  }

  /**
   * The thread is gone: crashed, exited or terminated for a timeout. The page
   * it was drawing fails; pages waiting behind it, and the documents open on
   * it, go to another thread.
   */
  private lost(error: unknown): void {
    if (this.dead) return
    this.dead = true
    clearTimeout(this.idleTimer)
    void this.worker.terminate()
    this.pool.forget(this)

    if (this.current) {
      clearTimeout(this.current.timer)
      this.current.draw.reject(
        new RenderThreadLostError(this.current.draw.page, error)
      )
      this.current = null
    }
    for (const opening of this.opening.values())
      opening.reject(new RenderThreadLostError(null, error))
    this.opening.clear()
    for (const session of this.sessions) session.detach()
    this.sessions.clear()
    for (const draw of this.queue.splice(0)) draw.session.redraw(draw)
  }

  private maybeIdle(): void {
    if (this.dead) return
    // Nothing being drawn: the thread no longer holds the process open.
    if (!this.current && this.queue.length === 0 && this.opening.size === 0)
      this.worker.unref()
    if (this.load > 0) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS)
    this.idleTimer.unref()
  }

  /** A clean stop: nothing open, nothing queued. */
  stop(): Promise<number> {
    this.dead = true
    clearTimeout(this.idleTimer)
    this.pool.forget(this)
    return this.worker.terminate()
  }

  /** Waits for the page being drawn and those queued, then stops. */
  async drain(): Promise<void> {
    while (!this.dead && (this.current || this.queue.length > 0))
      await new Promise((resolve) => setTimeout(resolve, 20))
    if (!this.dead) await this.stop()
  }
}

/** One open document, pinned to a thread for as long as it stays alive. */
export class RenderSession {
  readonly id = nextSession++
  private thread: RenderThread | null = null
  private opened: Promise<number> | null = null
  private closed = false
  /** The storage read that failed under pdf.js, kept to report instead of its symptom. */
  readFailure: Error | null = null

  constructor(
    private readonly pool: RenderPool,
    readonly source: RangeSource
  ) {}

  /** Opens the document on a thread, if it is not open on a live one. Resolves with its page count. */
  open(): Promise<number> {
    if (this.closed)
      return Promise.reject(new Error("this render session is closed"))
    if (this.opened && this.thread && !this.thread.dead) return this.opened
    const thread = this.pool.pick()
    this.thread = thread
    this.opened = this.source
      .range(0, Math.min(this.source.size, RANGE_CHUNK_BYTES))
      .then((initial) => thread.open(this, this.source.size, initial))
    // A failure here is the caller's to see, through open() or draw().
    this.opened.catch(() => {})
    return this.opened
  }

  /** Draws one page on this document's thread. */
  draw(page: number, request: RenderRequest): Promise<EncodedPage> {
    return new Promise((resolve, reject) =>
      this.redraw({
        reopened: 0,
        session: this,
        page,
        request,
        resolve,
        reject,
      })
    )
  }

  /** (Re)sends a draw: to this session's thread, reopening it on a new one if it died. */
  redraw(draw: Draw): void {
    this.open().then(
      () => {
        if (!this.thread || this.thread.dead) return this.redraw(draw)
        this.thread.enqueue(draw)
      },
      (error: unknown) => {
        // The thread died while this document was opening on it, for a page
        // of some other document's. Once more, on another thread.
        if (error instanceof RenderThreadLostError && draw.reopened < 1) {
          draw.reopened += 1
          this.detach()
          return this.redraw(draw)
        }
        draw.reject(error)
      }
    )
  }

  /** Its thread died; the next draw opens it again somewhere else. */
  detach(): void {
    this.thread = null
    this.opened = null
  }

  close(): void {
    this.closed = true
    this.thread?.close(this)
    this.thread = null
  }
}

export class RenderPool {
  private readonly threads = new Set<RenderThread>()

  constructor(
    private readonly assets: ThreadAssets,
    readonly size: number,
    readonly timeoutMs: number
  ) {}

  get state() {
    return {
      threads: this.threads.size,
      size: this.size,
      sessions: [...this.threads].reduce(
        (sum, thread) => sum + thread.sessions.size,
        0
      ),
    }
  }

  /** The least-loaded thread, starting another while under the limit. */
  pick(): RenderThread {
    const live = [...this.threads].filter((thread) => !thread.dead)
    const least = live.sort((a, b) => a.load - b.load)[0]
    if (!least || (least.load > 0 && live.length < this.size)) {
      const thread = new RenderThread(this, this.assets)
      this.threads.add(thread)
      return thread
    }
    return least
  }

  forget(thread: RenderThread): void {
    this.threads.delete(thread)
  }

  open(source: RangeSource): RenderSession {
    return new RenderSession(this, source)
  }

  /** Stops every thread once the pages given to it are drawn. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.threads].map((thread) => thread.drain()))
  }

  /** Terminates one thread as if it had crashed. For tests. */
  crashOne(): boolean {
    const thread = [...this.threads].find((entry) => !entry.dead)
    if (!thread) return false
    void thread.worker.terminate()
    return true
  }
}

const shared = globalThis as unknown as {
  anonifyRenderPool?: RenderPool | null
}

/**
 * The process's pool, made on first use; null when it is switched off or its
 * entry is missing from this build, in which case pages are drawn in-process.
 * On `globalThis`, so the bundles Next.js builds share one pool.
 */
export function renderPool(
  assets: () => Omit<ThreadAssets, "entry">
): RenderPool | null {
  if (shared.anonifyRenderPool !== undefined) return shared.anonifyRenderPool
  if (!renderThreadsEnabled()) {
    shared.anonifyRenderPool = null
    return null
  }
  const entry = threadEntry()
  if (!existsSync(entry)) {
    console.warn(
      JSON.stringify({
        level: "warn",
        context: "render-pool",
        message: `${path.relative(process.cwd(), entry)} is not in this build, so PDF pages are drawn on the main thread. Add it to outputFileTracingIncludes.`,
      })
    )
    shared.anonifyRenderPool = null
    return null
  }
  shared.anonifyRenderPool = new RenderPool(
    { entry, ...assets() },
    cpuConcurrency(),
    renderTimeoutMs()
  )
  return shared.anonifyRenderPool
}

/** Stops the pool: on shutdown, and at the end of a script or a test. */
export async function closeRenderPool(): Promise<void> {
  const pool = shared.anonifyRenderPool
  shared.anonifyRenderPool = undefined
  await pool?.close()
}
