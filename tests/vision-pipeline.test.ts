import { describe, expect, it } from "vitest"

import {
  analyzePagesForVision,
  renderPagesForVision,
} from "@/lib/documents/pdf/page-images"
import { bufferRangeSource, type RangeSource } from "@/lib/storage/range-source"

import { makePdfFixture } from "./fixtures"

/**
 * The vision pass over a PDF's pages, with the model calls overlapping (#173).
 *
 * What has to hold is that the overlap changes nothing but the time: the same
 * pages, in the same order, with no more calls out than the setting allows
 * and no more page images alive than there are calls.
 */

const SCALE = 0.2

function pages(count: number) {
  return makePdfFixture(
    Array.from({ length: count }, (_, page) => [{ text: `Page ${page + 1}` }])
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Pages heavy enough that the file spans many of pdf.js's range chunks. */
function heavyPages(count: number) {
  return makePdfFixture(
    Array.from({ length: count }, (_, page) =>
      Array.from({ length: 40 }, (_, line) => ({
        text: `Line ${line} of page ${page + 1}: ${"filler text ".repeat(6)}`,
        size: 8,
      }))
    )
  )
}

/** A stand-in for the model call that takes a random while to answer. */
function slowModel(maxDelayMs: number) {
  let inFlight = 0
  let mostInFlight = 0
  let alive = 0
  let mostAlive = 0

  const analyze = async ({ page, png }: { page: number; png: Buffer }) => {
    alive++
    mostAlive = Math.max(mostAlive, alive)
    inFlight++
    mostInFlight = Math.max(mostInFlight, inFlight)
    await sleep(Math.random() * maxDelayMs)
    inFlight--
    alive--
    return { page, bytes: png.byteLength }
  }

  return {
    analyze,
    mostInFlight: () => mostInFlight,
    mostAlive: () => mostAlive,
  }
}

describe("analyzePagesForVision", () => {
  it("returns the same answers in page order as one page at a time, however the calls race", async () => {
    const bytes = await pages(12)
    const wanted = [2, 3, 5, 7, 8, 9, 10, 11, 12]

    const sequential = await analyzePagesForVision(
      bytes,
      wanted,
      async ({ page, png }) => ({ page, bytes: png.byteLength }),
      { scale: SCALE }
    )
    expect(sequential.map(({ page }) => page)).toEqual(wanted)

    for (let run = 0; run < 20; run++) {
      const model = slowModel(15)
      const concurrent = await analyzePagesForVision(
        bytes,
        wanted,
        model.analyze,
        {
          concurrency: 1 + (run % 5),
          scale: SCALE,
        }
      )
      expect(concurrent).toEqual(sequential)
    }
  }, 60_000)

  it("never has more calls out, or page images alive, than the limit", async () => {
    const bytes = await pages(30)
    const wanted = Array.from({ length: 30 }, (_, index) => index + 1)
    const model = slowModel(20)

    const results = await analyzePagesForVision(bytes, wanted, model.analyze, {
      concurrency: 3,
      scale: SCALE,
    })

    expect(results).toHaveLength(30)
    expect(model.mostInFlight()).toBe(3)
    expect(model.mostAlive()).toBeLessThanOrEqual(3)
  }, 60_000)

  it("overlaps the calls, so slow ones take about a page's time per slot", async () => {
    const bytes = await pages(12)
    const wanted = Array.from({ length: 12 }, (_, index) => index + 1)
    const call = async () => {
      await sleep(100)
    }

    const startedAt = Date.now()
    await analyzePagesForVision(bytes, wanted, call, {
      concurrency: 4,
      scale: SCALE,
    })
    const elapsed = Date.now() - startedAt

    // One at a time would be 1.2 s of waiting; four slots is three rounds.
    expect(elapsed).toBeLessThan(900)
  }, 30_000)

  it("leaves out pages the document does not have", async () => {
    const bytes = await pages(3)
    const results = await analyzePagesForVision(
      bytes,
      [0, 1, 3, 4],
      async ({ page }) => page,
      { concurrency: 2, scale: SCALE }
    )
    expect(results.map(({ page }) => page)).toEqual([1, 3])
  })

  it("fails when a read under it fails, rather than waiting on it", async () => {
    const bytes = await heavyPages(1000)
    expect(bytes.byteLength).toBeGreaterThan(12 * 64 * 1024)
    const inner = bufferRangeSource(bytes)
    let calls = 0
    const failing: RangeSource = {
      size: inner.size,
      range: async (start, end) => {
        calls += 1
        if (calls > 2) throw new Error("storage went away")
        return inner.range(start, end)
      },
    }

    await expect(
      analyzePagesForVision(
        failing,
        [250, 500, 750, 1000],
        async () => sleep(10),
        {
          concurrency: 3,
          scale: SCALE,
        }
      )
    ).rejects.toThrow(/storage went away/)
  }, 30_000)

  it("a model call that throws fails the pass", async () => {
    const bytes = await pages(4)
    await expect(
      analyzePagesForVision(
        bytes,
        [1, 2, 3, 4],
        async ({ page }) => {
          if (page === 3) throw new Error("model fell over")
          return page
        },
        { concurrency: 2, scale: SCALE }
      )
    ).rejects.toThrow(/model fell over/)
  })

  it("renderPagesForVision still renders the pages in order", async () => {
    const bytes = await pages(4)
    const rendered = await renderPagesForVision(bytes, [4, 2], SCALE)
    expect(rendered.map(({ page }) => page)).toEqual([4, 2])
    for (const { png } of rendered) {
      expect(png.subarray(1, 4).toString()).toBe("PNG")
    }
  })
})
