import { cpuConcurrency } from "@/lib/runtime/capacity"

/**
 * Tesseract workers, shared by every document in the process (#189).
 *
 * Every document used to start a worker of its own: WebAssembly initialised
 * and the model loaded each time, then thrown away at the end. Ten scanned
 * documents at once meant ten workers, each with its own copy of the model,
 * however many CPUs there were.
 *
 * Now there is one pool per configuration (language, model directory and
 * where models come from: the model is fixed per worker), started on first
 * use and kept warm:
 *
 * - **At most `cpuConcurrency()` workers** (#181), started only as the queue
 *   needs them. The pool is the CPU limit for recognition: Tesseract runs on
 *   its own worker threads, so a recognition holds no CPU slot, and the slots
 *   are left to the rendering on this thread.
 * - **Idle for `ANONIFY_OCR_IDLE_SECONDS`** (300), the workers are stopped and
 *   their memory returned; the next page starts them again.
 * - **On shutdown** (#182), stopped after the steps that use them finish.
 *
 * On `globalThis`, so the bundles Next.js builds share one pool.
 */

type Env = Record<string, string | undefined>

export const OCR_IDLE_ENV = "ANONIFY_OCR_IDLE_SECONDS"
export const DEFAULT_OCR_IDLE_SECONDS = 300

/** `ANONIFY_OCR_IDLE_SECONDS` (0–86400; 0 stops workers as soon as idle). */
export function ocrIdleMs(env: Env = process.env): number {
  const raw = env[OCR_IDLE_ENV]?.trim()
  if (!raw) return DEFAULT_OCR_IDLE_SECONDS * 1000
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 86_400)
    throw new Error(
      `${OCR_IDLE_ENV} must be a whole number of seconds from 0 to 86400`
    )
  return value * 1000
}

/** What a pool needs from tesseract.js's worker. */
export type PoolWorker = {
  recognize: (
    image: Buffer,
    options?: unknown,
    output?: unknown
  ) => Promise<{ data: { text?: string; blocks?: unknown } }>
  terminate: () => Promise<unknown>
}

export type PoolOptions = {
  /** Starts one worker for this configuration. */
  createWorker: () => Promise<PoolWorker>
  size: number
  idleMs: number
}

type Job = {
  image: Buffer
  resolve: (data: { text?: string; blocks?: unknown }) => void
  reject: (error: unknown) => void
}

/**
 * A fixed-size set of workers and a first-come queue of pages.
 *
 * Hand-rolled rather than tesseract.js's `createScheduler`, which takes
 * workers that already exist: this one starts them as the queue grows, and
 * stops them all when it has been idle.
 */
export class TesseractPool {
  private readonly idle: PoolWorker[] = []
  private readonly all = new Set<PoolWorker>()
  private readonly queue: Job[] = []
  private starting = 0
  private busy = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(private readonly options: PoolOptions) {}

  get state() {
    return {
      workers: this.all.size,
      starting: this.starting,
      busy: this.busy,
      queued: this.queue.length,
      size: this.options.size,
    }
  }

  recognize(image: Buffer): Promise<{ text?: string; blocks?: unknown }> {
    if (this.closed) return Promise.reject(new Error("the OCR pool is closed"))
    clearTimeout(this.idleTimer)
    return new Promise((resolve, reject) => {
      this.queue.push({ image, resolve, reject })
      this.dispatch()
    })
  }

  private dispatch(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      this.run(this.idle.pop()!, this.queue.shift()!)
    }
    // A worker more only when pages are waiting that the ones starting will
    // not cover.
    const wanted = Math.min(
      this.queue.length - this.starting,
      this.options.size - this.all.size - this.starting
    )
    for (let i = 0; i < wanted; i++) this.start()
  }

  private start(): void {
    this.starting += 1
    this.options.createWorker().then(
      (worker) => {
        this.starting -= 1
        if (this.closed) {
          void worker.terminate()
          return
        }
        this.all.add(worker)
        this.idle.push(worker)
        this.dispatch()
        this.maybeIdle()
      },
      (error) => {
        this.starting -= 1
        // Nothing to run the waiting pages on: fail them rather than hang.
        if (this.all.size === 0 && this.starting === 0) {
          for (const job of this.queue.splice(0)) job.reject(error)
        }
      }
    )
  }

  private run(worker: PoolWorker, job: Job): void {
    this.busy += 1
    // The worker goes back before the caller hears the answer: a caller that
    // reads its next page straight away must find it free, not start another.
    worker.recognize(job.image, {}, { blocks: true }).then(
      ({ data }) => {
        this.release(worker)
        job.resolve(data)
      },
      (error) => {
        this.release(worker)
        job.reject(error)
      }
    )
  }

  private release(worker: PoolWorker): void {
    this.busy -= 1
    if (this.closed) return
    this.idle.push(worker)
    this.dispatch()
    this.maybeIdle()
  }

  private maybeIdle(): void {
    if (this.busy > 0 || this.queue.length > 0 || this.starting > 0) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(
      () => void this.stopWorkers(),
      this.options.idleMs
    )
    this.idleTimer.unref?.()
  }

  /** Stops every idle worker; the next page starts them again. */
  private async stopWorkers(): Promise<void> {
    if (this.busy > 0 || this.queue.length > 0) return
    const workers = this.idle.splice(0)
    for (const worker of workers) this.all.delete(worker)
    await Promise.allSettled(workers.map((worker) => worker.terminate()))
  }

  /** Stops everything, once the pages already given to it are read. */
  async close(): Promise<void> {
    clearTimeout(this.idleTimer)
    while (this.busy > 0 || this.queue.length > 0 || this.starting > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    this.closed = true
    const workers = [...this.all]
    this.all.clear()
    this.idle.length = 0
    await Promise.allSettled(workers.map((worker) => worker.terminate()))
  }
}

const shared = globalThis as unknown as {
  anonifyTesseractPools?: Map<string, TesseractPool>
}

function pools(): Map<string, TesseractPool> {
  shared.anonifyTesseractPools ??= new Map()
  return shared.anonifyTesseractPools
}

/** The pool for one configuration, made on first use. */
export function tesseractPool(
  key: string,
  createWorker: () => Promise<PoolWorker>
): TesseractPool {
  let pool = pools().get(key)
  if (!pool) {
    pool = new TesseractPool({
      createWorker,
      size: cpuConcurrency(),
      idleMs: ocrIdleMs(),
    })
    pools().set(key, pool)
  }
  return pool
}

/** Stops every pool: on shutdown, and at the end of a script or a test. */
export async function closeTesseractPools(): Promise<void> {
  const all = [...pools().values()]
  pools().clear()
  await Promise.allSettled(all.map((pool) => pool.close()))
}

/** Workers across every pool, for tests and the benchmark. */
export function tesseractPoolState() {
  return [...pools().entries()].map(([key, pool]) => ({ key, ...pool.state }))
}
