import { afterEach, describe, expect, it, vi } from "vitest"

import { ocrPdfPages } from "@/lib/documents/pdf/ocr"
import {
  ocrIdleMs,
  TesseractPool,
  type PoolWorker,
} from "@/lib/ocr/tesseract-pool"
import { greyPgm } from "@/lib/ocr/raster"
import { createCanvas } from "@napi-rs/canvas"
import type { PDFDocumentProxy } from "pdfjs-dist"

/**
 * The shared Tesseract pool and the pipelined page reader (#189), with fake
 * workers: what is being checked is scheduling, not recognition, which the
 * OCR suites check against the real engine.
 */

afterEach(() => {
  vi.useRealTimers()
})

function fakeWorkers(readMs = 5) {
  const made: PoolWorker[] = []
  let terminated = 0
  let reading = 0
  let mostReading = 0
  const createWorker = async (): Promise<PoolWorker> => {
    const worker: PoolWorker = {
      recognize: async (image) => {
        reading += 1
        mostReading = Math.max(mostReading, reading)
        await new Promise((resolve) => setTimeout(resolve, readMs))
        reading -= 1
        return { data: { text: image.toString(), blocks: [] } }
      },
      terminate: async () => {
        terminated += 1
      },
    }
    made.push(worker)
    return worker
  }
  return {
    createWorker,
    made,
    terminated: () => terminated,
    mostReading: () => mostReading,
  }
}

describe("the Tesseract pool", () => {
  it("starts no more workers than its size, however many pages wait", async () => {
    const workers = fakeWorkers()
    const pool = new TesseractPool({ ...workers, size: 3, idleMs: 60_000 })
    const pages = Array.from({ length: 20 }, (_, i) => Buffer.from(`p${i}`))
    const read = await Promise.all(pages.map((page) => pool.recognize(page)))

    expect(read.map((data) => data.text)).toEqual(pages.map(String))
    expect(workers.made.length).toBe(3)
    expect(workers.mostReading()).toBe(3)
    await pool.close()
  })

  it("starts only the workers the queue needs", async () => {
    const workers = fakeWorkers()
    const pool = new TesseractPool({ ...workers, size: 8, idleMs: 60_000 })
    await pool.recognize(Buffer.from("one"))
    await pool.recognize(Buffer.from("two"))
    // One page at a time never needed a second worker.
    expect(workers.made.length).toBe(1)
    await pool.close()
  })

  it("stops its workers when idle, and starts again on the next page", async () => {
    const workers = fakeWorkers(1)
    const pool = new TesseractPool({ ...workers, size: 2, idleMs: 20 })
    await pool.recognize(Buffer.from("before"))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(workers.terminated()).toBe(1)
    expect(pool.state.workers).toBe(0)

    await pool.recognize(Buffer.from("after"))
    expect(workers.made.length).toBe(2)
    await pool.close()
  })

  it("closes once the pages it was given are read, and refuses more", async () => {
    const workers = fakeWorkers(30)
    const pool = new TesseractPool({ ...workers, size: 1, idleMs: 60_000 })
    const pending = pool.recognize(Buffer.from("in flight"))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await pool.close()
    expect((await pending).text).toBe("in flight")
    expect(workers.terminated()).toBe(1)
    await expect(pool.recognize(Buffer.from("late"))).rejects.toThrow(/closed/)
  })

  it("fails the waiting pages when no worker can start", async () => {
    const pool = new TesseractPool({
      createWorker: async () => {
        throw new Error("model missing")
      },
      size: 2,
      idleMs: 60_000,
    })
    await expect(pool.recognize(Buffer.from("x"))).rejects.toThrow(
      "model missing"
    )
  })

  it("reads its idle setting, and refuses a malformed one", () => {
    expect(ocrIdleMs({})).toBe(300_000)
    expect(ocrIdleMs({ ANONIFY_OCR_IDLE_SECONDS: "0" })).toBe(0)
    expect(() => ocrIdleMs({ ANONIFY_OCR_IDLE_SECONDS: "-1" })).toThrow(
      /ANONIFY_OCR_IDLE_SECONDS/
    )
  })
})

describe("the page hand-off", () => {
  it("is greyscale with Leptonica's weights", () => {
    const canvas = createCanvas(2, 1)
    const context = canvas.getContext("2d")
    context.fillStyle = "rgb(200, 100, 50)"
    context.fillRect(0, 0, 1, 1)
    context.fillStyle = "#ffffff"
    context.fillRect(1, 0, 1, 1)
    const pgm = greyPgm(canvas)
    const header = "P5\n2 1\n255\n"
    expect(pgm.subarray(0, header.length).toString("ascii")).toBe(header)
    // 0.3·200 + 0.5·100 + 0.2·50 = 120
    expect([...pgm.subarray(header.length)]).toEqual([120, 255])
  })
})

describe("reading the pages of a scan", () => {
  /** A PDF of `count` blank pages, enough for the renderer. */
  function fakePdf(count: number, drawn: number[]): PDFDocumentProxy {
    return {
      numPages: count,
      getPage: async (number: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 10 * scale,
          height: 10 * scale,
        }),
        render: () => {
          drawn.push(number)
          return { promise: Promise.resolve() }
        },
        cleanup: () => {},
      }),
    } as unknown as PDFDocumentProxy
  }

  it("draws ahead while pages are read, holding at most lookahead + 1", async () => {
    const drawn: number[] = []
    let alive = 0
    let mostAlive = 0
    const read = await ocrPdfPages(
      fakePdf(8, drawn),
      [1, 2, 3, 4, 5, 6, 7, 8],
      {
        lookahead: 2,
        format: "pgm",
        recognize: async (image) => {
          alive += 1
          mostAlive = Math.max(mostAlive, alive)
          expect(image.subarray(0, 2).toString()).toBe("P5")
          await new Promise((resolve) => setTimeout(resolve, 10))
          alive -= 1
          return {
            words: [
              {
                text: "word",
                confidence: 90,
                bbox: { x0: 0, y0: 0, x1: 4, y1: 2 },
              },
            ],
            text: "word",
            granularity: "word",
          }
        },
      }
    )

    expect(drawn).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(mostAlive).toBe(3)
    expect([...read.keys()].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])
  })
})
