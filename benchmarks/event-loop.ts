/**
 * How responsive the server stays while it reads a scan (#194).
 *
 *   pnpm exec tsx benchmarks/event-loop.ts [--pages 40] [--export 10] [--only export]
 *   ANONIFY_RENDER_THREADS=off pnpm exec tsx benchmarks/event-loop.ts
 *
 * Builds a scanned PDF of `--pages` pages from the corpus (every page an
 * image at 200 DPI, no text layer), then, in this one process, as an `all`
 * container would:
 *
 * 1. extracts it with OCR, as ingest does, and
 * 2. exports it with `--export` pages redacted,
 *
 * while a small HTTP server on the same event loop is asked for a trivial
 * answer every 50ms, standing in for the workspace's API. Reports the event
 * loop's delay (p50, p99, max, from `monitorEventLoopDelay`) and those
 * requests' latency, for the extraction and the export separately. Run it
 * once with the render pool and once without to compare. The target is a p99
 * delay under 50ms.
 *
 * Needs the OCR model (`pnpm ocr:warm`). Nothing leaves the machine.
 */

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { parseArgs } from "node:util"

import { PDFDocument } from "pdf-lib"

import { extractPdf } from "@/lib/documents/pdf/extract"
import { redactPdf } from "@/lib/documents/pdf/redact"
import {
  loadPdfjsForRender,
  openPdfDocument,
  renderPage,
} from "@/lib/documents/pdf/render"
import {
  closeRenderPool,
  renderThreadsEnabled,
} from "@/lib/documents/pdf/render-pool"
import { closeTesseractPools } from "@/lib/ocr/tesseract-pool"
import { cpuConcurrency } from "@/lib/runtime/capacity"

import { renderDocument } from "./corpus/lib/render"
import { loadCorpus, percentile } from "./lib/corpus"

const HERE = import.meta.dirname
const SCAN_SCALE = 200 / 72

const { values } = parseArgs({
  options: {
    pages: { type: "string", default: "40" },
    export: { type: "string", default: "10" },
    only: { type: "string", default: "all" },
  },
})
const wantedPages = Number(values.pages)
const exportPages = Number(values.export)

/** Corpus PDFs, rasterised a page at a time, until there are enough pages. */
async function scan(pages: number): Promise<Uint8Array> {
  const documents = (
    await loadCorpus(path.join(HERE, "corpus", "synthetic-v1"), "dev")
  )
    .filter((document) => document.render.includes("pdf"))
    .sort((a, b) => a.id.localeCompare(b.id))
  const pdfjs = await loadPdfjsForRender()
  const output = await PDFDocument.create()
  for (const document of documents) {
    const { bytes } = await renderDocument(document, "pdf")
    const { task } = await openPdfDocument(pdfjs, bytes)
    const source = await task.promise
    try {
      for (let number = 1; number <= source.numPages; number++) {
        const page = await source.getPage(number)
        const { canvas, width, height } = await renderPage(page, SCAN_SCALE)
        page.cleanup()
        const image = await output.embedPng(canvas.toBuffer("image/png"))
        output
          .addPage([width, height])
          .drawImage(image, { x: 0, y: 0, width, height })
        if (output.getPageCount() >= pages) return output.save()
      }
    } finally {
      await task.destroy()
    }
  }
  return output.save()
}

/** A server on this event loop, and a client asking it something every 50ms. */
async function pinger() {
  const server = createServer((_, response) => response.end("ok"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  let latencies: number[] = []
  let running = true
  const loop = (async () => {
    while (running) {
      const started = performance.now()
      await fetch(url).then((response) => response.text())
      latencies.push(performance.now() - started)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })()
  return {
    take() {
      const taken = latencies
      latencies = []
      return taken
    },
    async stop() {
      running = false
      await loop
      server.close()
    },
  }
}

async function measure(
  label: string,
  ping: Awaited<ReturnType<typeof pinger>>,
  work: () => Promise<unknown>
) {
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  ping.take()
  histogram.enable()
  const began = performance.now()
  await work()
  const seconds = (performance.now() - began) / 1000
  histogram.disable()
  const requests = ping.take()
  const ms = (nanoseconds: number) => (nanoseconds / 1e6).toFixed(0)
  console.log(
    `| ${label} | ${seconds.toFixed(1)}s | ${ms(histogram.percentile(50))} | ` +
      `${ms(histogram.percentile(99))} | ${ms(histogram.max)} | ` +
      `${percentile(requests, 0.5).toFixed(0)} | ${percentile(requests, 0.99).toFixed(0)} | ` +
      `${Math.max(0, ...requests).toFixed(0)} |`
  )
}

async function main() {
  const pdf = await scan(wantedPages)
  const pages = (await PDFDocument.load(pdf)).getPageCount()
  console.log(
    `${pages}-page scan, ${(pdf.byteLength / 1024 / 1024).toFixed(1)} MiB; ` +
      `render threads ${renderThreadsEnabled() ? "on" : "off"}, ` +
      `${cpuConcurrency()} CPU slots, ${os.availableParallelism()} CPUs\n`
  )
  console.log(
    "| Work | Took | Loop p50 ms | Loop p99 ms | Loop max ms | Request p50 ms | Request p99 ms | Request max ms |"
  )
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")

  const ping = await pinger()
  try {
    if (values.only !== "export")
      await measure(`extract with OCR, ${pages} pages`, ping, () =>
        extractPdf("bench-event-loop", pdf, { ocr: true })
      )
    const boxes = new Map(
      Array.from({ length: Math.min(exportPages, pages) }, (_, index) => [
        index + 1,
        [{ x: 72, y: 72, width: 200, height: 20 }],
      ])
    )
    if (values.only !== "extract")
      await measure(
        `export, ${boxes.size} of ${pages} pages redacted`,
        ping,
        () =>
          redactPdf(pdf, {
            boxesByPage: boxes,
            label: null,
            sanitizeMetadata: true,
          })
      )
  } finally {
    await ping.stop()
    await closeTesseractPools()
    await closeRenderPool()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
