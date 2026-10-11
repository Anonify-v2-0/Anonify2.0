import { createCanvas } from "@napi-rs/canvas"
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib"
import { afterAll, describe, expect, it } from "vitest"

import {
  inProcessRenderer,
  openPageRenderer,
} from "@/lib/documents/pdf/page-renderer"
import { renderAndEncode } from "@/lib/documents/pdf/raster-core.mjs"
import {
  loadPdfjsForRender,
  openPdfDocument,
  renderThreadAssets,
} from "@/lib/documents/pdf/render"
import {
  canvasModuleUrl,
  closeRenderPool,
  RenderPool,
  renderThreadsEnabled,
  RenderThreadLostError,
  renderTimeoutMs,
  RenderTimeoutError,
  threadEntry,
} from "@/lib/documents/pdf/render-pool"
import { bufferRangeSource } from "@/lib/storage/range-source"
import { describeFailure } from "@/lib/workflows/failure"

/**
 * The render pool (#194): pages drawn on worker threads come out exactly as
 * they did on the main thread, and a thread that dies or hangs costs the
 * page it was drawing and nothing else.
 */

afterAll(() => closeRenderPool())

async function letter(pages = 2): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= pages; number++) {
    const page = pdf.addPage([300, 200])
    page.drawText(`Page ${number}: Jane Doe, jane@example.com`, {
      x: 20,
      y: 150,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    })
  }
  return pdf.save()
}

/**
 * A page whose content stream is hundreds of thousands of tiny filled
 * rectangles: legal, and slow to draw. A stand-in for the pathological PDFs
 * that used to stall the whole server.
 */
async function slowPage(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([600, 600])
  const operators: string[] = []
  for (let index = 0; index < 400_000; index++)
    operators.push(`${index % 600} ${(index * 7) % 600} 0.5 0.5 re f`)
  const stream = pdf.context.flateStream(operators.join("\n"))
  page.node.set(PDFName.of("Contents"), pdf.context.register(stream))
  return pdf.save()
}

function pool(timeoutMs = 60_000, size = 2): RenderPool {
  return new RenderPool(
    {
      entry: threadEntry(),
      ...renderThreadAssets(),
      canvasUrl: canvasModuleUrl(),
    },
    size,
    timeoutMs
  )
}

const REQUESTS = [
  { scale: 1.5, output: "png" as const },
  { scale: 2, output: "pgm" as const },
  {
    scale: 2,
    output: "flate-rgb" as const,
    boxes: [
      { x: 20, y: 40, width: 120, height: 14, label: "PERSON_001" },
      { x: 150, y: 40, width: 100, height: 14 },
    ],
    label: "REDACTED",
  },
]

describe("the render pool", () => {
  it("draws the same bytes on a thread as on the main thread", async () => {
    const bytes = await letter()
    const pdfjs = await loadPdfjsForRender()
    const { task } = await openPdfDocument(pdfjs, bytes)
    const pdf = await task.promise
    const here = inProcessRenderer(pdf)
    const threads = pool()
    const session = threads.open(bufferRangeSource(bytes))
    try {
      expect(await session.open()).toBe(2)
      for (const request of REQUESTS) {
        const expected = await here.draw(2, request)
        const drawn = await session.draw(2, request)
        expect(drawn.pixelWidth).toBe(expected.pixelWidth)
        expect(drawn.width).toBe(expected.width)
        expect(Buffer.compare(drawn.data, expected.data)).toBe(0)
      }
    } finally {
      session.close()
      await threads.close()
      await task.destroy()
    }
  })

  it("is what openPageRenderer uses, unless switched off", async () => {
    const renderer = await openPageRenderer(await letter(1))
    try {
      expect(renderer.threaded).toBe(renderThreadsEnabled())
      expect(renderer.pageCount).toBe(1)
      const { data } = await renderer.draw(1, { scale: 1, output: "png" })
      expect(data.subarray(1, 4).toString("ascii")).toBe("PNG")
    } finally {
      await renderer.close()
    }
  })

  it("fails a page whose thread dies with a retryable error, and carries on", async () => {
    const threads = pool()
    const session = threads.open(bufferRangeSource(await slowPage()))
    try {
      await session.open()
      const drawing = session.draw(1, { scale: 2, output: "png" })
      // Mid-page, as an out-of-memory kill or a native crash would.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(threads.crashOne()).toBe(true)
      const error = await drawing.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RenderThreadLostError)
      expect(describeFailure(error).retryable).toBe(true)

      // The same document, on a new thread, from where it was.
      const other = threads.open(bufferRangeSource(await letter()))
      await other.open()
      const { data } = await other.draw(1, { scale: 1, output: "pgm" })
      expect(data.subarray(0, 2).toString("ascii")).toBe("P5")
      other.close()
    } finally {
      session.close()
      await threads.close()
    }
  })

  it("stops a page that takes too long, and only that page", async () => {
    const threads = pool(500, 1)
    const slow = threads.open(bufferRangeSource(await slowPage()))
    const fine = threads.open(bufferRangeSource(await letter()))
    try {
      await slow.open()
      await fine.open()
      // Queued behind the slow page, on the pool's only thread.
      const [stopped, drawn] = await Promise.allSettled([
        slow.draw(1, { scale: 2, output: "png" }),
        fine.draw(2, { scale: 1, output: "png" }),
      ])
      expect(stopped.status).toBe("rejected")
      const error = (stopped as PromiseRejectedResult).reason
      expect(error).toBeInstanceOf(RenderTimeoutError)
      // A verdict on the file: the same page takes as long next time.
      expect(describeFailure(error)).toMatchObject({
        code: "too-complex",
        retryable: false,
      })
      expect(drawn.status).toBe("fulfilled")
    } finally {
      slow.close()
      fine.close()
      await threads.close()
    }
  }, 30_000)

  it("reports a storage read that fails under it, not its symptom", async () => {
    // Larger than the first read, so pdf.js has to come back for more.
    const bytes = await letter(400)
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024)
    const source = bufferRangeSource(bytes)
    let reads = 0
    const failing = {
      size: source.size,
      async range(start: number, end: number) {
        // The first read opens the document; the next is a page's.
        if (++reads > 1) throw new Error("storage went away")
        return source.range(start, end)
      },
    }
    const threads = pool()
    const session = threads.open(failing)
    try {
      const outcome = await session
        .open()
        .then(() => session.draw(400, { scale: 1, output: "png" }))
        .catch((error: unknown) => error)
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toBe("storage went away")
    } finally {
      session.close()
      await threads.close()
    }
  })
})

describe("render pool settings", () => {
  it("is on unless switched off", () => {
    expect(renderThreadsEnabled({})).toBe(true)
    expect(renderThreadsEnabled({ ANONIFY_RENDER_THREADS: "off" })).toBe(false)
    expect(() =>
      renderThreadsEnabled({ ANONIFY_RENDER_THREADS: "sometimes" })
    ).toThrow(/ANONIFY_RENDER_THREADS/)
  })

  it("limits a page to two minutes, adjustably", () => {
    expect(renderTimeoutMs({})).toBe(120_000)
    expect(renderTimeoutMs({ ANONIFY_RENDER_TIMEOUT_MS: "5000" })).toBe(5000)
    expect(() => renderTimeoutMs({ ANONIFY_RENDER_TIMEOUT_MS: "10" })).toThrow(
      /ANONIFY_RENDER_TIMEOUT_MS/
    )
  })
})

describe("raster-core", () => {
  it("burns a box in where it was asked for", async () => {
    const pdfjs = await loadPdfjsForRender()
    const { task } = await openPdfDocument(pdfjs, await letter(1))
    const page = await (await task.promise).getPage(1)
    try {
      const { data, pixelWidth } = await renderAndEncode(
        page,
        {
          scale: 1,
          output: "pgm",
          boxes: [{ x: 10, y: 10, width: 30, height: 5 }],
        },
        createCanvas
      )
      const header = data.indexOf("255\n") + 4
      // Black inside the box, white paper outside it.
      expect(data[header + 12 * pixelWidth + 20]).toBe(0)
      expect(data[header + 100 * pixelWidth + 280]).toBe(255)
    } finally {
      page.cleanup()
      await task.destroy()
    }
  })
})
