import { AsyncLocalStorage } from "node:async_hooks"

import { cpuConcurrency } from "@/lib/runtime/capacity"

/**
 * One process's CPU-bound work, taken in turns (#181).
 *
 * Rendering a PDF page, encoding its raster, reading it with Tesseract and
 * compositing an image redaction are the work that saturates a CPU. Without a
 * bound, ten jobs on two CPUs all ran at once and all slowed down together,
 * every one of them missing its deadline. pdf.js and the canvas run on the
 * event loop, so beyond the CPUs available they only interleave: the same
 * total time, every page finishing last, and every raster alive at once.
 *
 * `withCpuSlot(fn)` runs `fn` once one of `cpuConcurrency()` slots is free,
 * first come first served. A slot is held for the CPU-bound section only:
 * never across a model call, never across reading a document from storage.
 * The one exception is a PDF opened by ranges, whose renderer may fetch a
 * byte range of the page it is drawing: pdf.js reads lazily as it renders,
 * and splitting the two would parse every page twice.
 *
 * Re-entrant: work already holding a slot that asks for one runs in the slot
 * it has. A page render takes a slot, and so does the export around it; with
 * one slot, a second acquire would wait for itself forever.
 *
 * Process-wide on `globalThis`, not per module: Next.js bundles
 * instrumentation and the route handlers separately, so a module variable is
 * one semaphore per bundle (see lib/health/state.ts).
 */

export class Semaphore {
  private inUse = 0
  private readonly queue: (() => void)[] = []

  constructor(readonly slots: number) {
    if (!Number.isInteger(slots) || slots < 1)
      throw new Error(`a semaphore needs at least one slot, got ${slots}`)
  }

  /** Waits for a slot; the returned function gives it back, once. */
  async acquire(): Promise<() => void> {
    if (this.inUse < this.slots && this.queue.length === 0) {
      this.inUse += 1
    } else {
      // The releaser hands its slot straight to the next in line, so a
      // newcomer can never overtake somebody already waiting.
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) next()
      else this.inUse -= 1
    }
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  get state(): { inUse: number; waiting: number; slots: number } {
    return { inUse: this.inUse, waiting: this.queue.length, slots: this.slots }
  }
}

type Held = { held: boolean }

const shared = globalThis as unknown as {
  anonifyCpuSlots?: Semaphore
  anonifyCpuSlotHolder?: AsyncLocalStorage<Held>
}

/** The process's semaphore, sized on first use. */
export function cpuSlots(): Semaphore {
  shared.anonifyCpuSlots ??= new Semaphore(cpuConcurrency())
  return shared.anonifyCpuSlots
}

function holder(): AsyncLocalStorage<Held> {
  shared.anonifyCpuSlotHolder ??= new AsyncLocalStorage<Held>()
  return shared.anonifyCpuSlotHolder
}

/** Runs `fn` in a CPU slot. Hold it for CPU-bound work only. */
export async function withCpuSlot<T>(fn: () => Promise<T> | T): Promise<T> {
  if (holder().getStore()?.held) return fn()

  const release = await cpuSlots().acquire()
  // Cleared on release, so work this slot started and left running is not
  // mistaken for work that still holds it.
  const token: Held = { held: true }
  try {
    return await holder().run(token, fn)
  } finally {
    token.held = false
    release()
  }
}

/** Slots in use and work waiting for one, for metrics (#188). */
export function cpuSlotState(): {
  inUse: number
  waiting: number
  slots: number
} {
  return cpuSlots().state
}

/** For tests: a fresh semaphore of the given size. */
export function resetCpuSlots(slots?: number): void {
  shared.anonifyCpuSlots = slots ? new Semaphore(slots) : undefined
}
