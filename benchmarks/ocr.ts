/**
 * OCR throughput, the page hand-off, and the render-scale study (#189).
 *
 *   pnpm bench:ocr                          # everything, 12 dev documents
 *   pnpm bench:ocr --part handoff           # PNG against greyscale PGM
 *   pnpm bench:ocr --part scale --scales 1.5,2,2.5
 *   pnpm bench:ocr --part throughput --docs 5
 *
 * The corpus has no scanned documents (its PDFs are born digital), so this
 * makes some: each document is rendered to PDF the way corpus:score does,
 * every page rasterised at 200 DPI, and the rasters put back into a PDF with
 * no text layer. That is a clean scan, without a scanner's noise, which is
 * what a comparison between two settings needs: the same input each time.
 *
 * Needs the pinned OCR model in the cache (`pnpm ocr:warm`, or the file named
 * in tests/fixtures/ocr/model.json). Nothing leaves the machine.
 *
 * - handoff: every page drawn at 2x and handed to one Tesseract worker as
 *   PNG and as greyscale PGM. Times the encode and the recognition, and checks
 *   the words and their boxes are identical.
 * - scale: OCR at each scale through the pipeline's own path, scored against
 *   the labels: the share of labelled values found in the OCR text (spaces
 *   ignored), the share of the document's words read, and time per page.
 * - throughput: pages per minute for one document, then for several at once,
 *   and the peak resident memory, both before #189 (a worker per document,
 *   pages one after another, PNG: reproduced here) and now.
 */

import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

import { PDFDocument } from "pdf-lib"

import { mapWithConcurrency } from "@/lib/concurrency"
import { ocrPdfPages } from "@/lib/documents/pdf/ocr"
import {
  loadPdfjsForRender,
  openPdfDocument,
  renderPage,
} from "@/lib/documents/pdf/render"
import { encodeRaster } from "@/lib/ocr/raster"
import { modelDirectory, tesseractProvider } from "@/lib/ocr/tesseract"
import { closeTesseractPools } from "@/lib/ocr/tesseract-pool"
import { tesseractLanguage } from "@/lib/ocr/models"

import { renderDocument } from "./corpus/lib/render"
import type { LabelledDocument } from "./corpus/lib/types"
import { loadCorpus } from "./lib/corpus"

const HERE = import.meta.dirname

/** A scanner's usual resolution, in PDF units (72 per inch). */
const SCAN_SCALE = 200 / 72

type Scan = { document: LabelledDocument; pdf: Uint8Array; pages: number }

let peakRss = 0
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 50)
sampler.unref()

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`
}

/** A born-digital PDF, as a scan: every page an image, no text layer. */
async function scanOf(
  bytes: Uint8Array
): Promise<{ pdf: Uint8Array; pages: number }> {
  const pdfjs = await loadPdfjsForRender()
  const { task } = await openPdfDocument(pdfjs, bytes)
  const source = await task.promise
  const output = await PDFDocument.create()
  try {
    for (let number = 1; number <= source.numPages; number++) {
      const page = await source.getPage(number)
      const { canvas, width, height } = await renderPage(page, SCAN_SCALE)
      page.cleanup()
      const image = await output.embedPng(canvas.toBuffer("image/png"))
      output
        .addPage([width, height])
        .drawImage(image, { x: 0, y: 0, width, height })
    }
  } finally {
    await task.destroy()
  }
  return { pdf: await output.save(), pages: output.getPageCount() }
}

async function scans(count: number): Promise<Scan[]> {
  const root = path.join(HERE, "corpus", "synthetic-v1")
  const documents = (await loadCorpus(root, "dev"))
    .filter((document) => document.render.includes("pdf"))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, count)
  const made: Scan[] = []
  for (const document of documents) {
    const rendered = await renderDocument(document, "pdf")
    made.push({ document, ...(await scanOf(rendered.bytes)) })
  }
  return made
}

/** Every page of every scan drawn at `scale`, one at a time. */
async function* pagesOf(scanned: Scan[], scale: number) {
  const pdfjs = await loadPdfjsForRender()
  for (const scan of scanned) {
    const { task } = await openPdfDocument(pdfjs, scan.pdf)
    const pdf = await task.promise
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number)
        const rendered = await renderPage(page, scale)
        page.cleanup()
        yield { scan, number, canvas: rendered.canvas }
      }
    } finally {
      await task.destroy()
    }
  }
}

type TessWord = {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

function wordsOf(data: { blocks?: unknown }): TessWord[] {
  const words: TessWord[] = []
  type Block = { paragraphs?: { lines?: { words?: TessWord[] }[] }[] }
  for (const block of (data.blocks ?? []) as Block[])
    for (const paragraph of block.paragraphs ?? [])
      for (const line of paragraph.lines ?? [])
        for (const word of line.words ?? [])
          words.push({ text: word.text, bbox: word.bbox })
  return words
}

async function handoff(scanned: Scan[]) {
  const { createWorker } = await import("tesseract.js")
  const worker = await createWorker(tesseractLanguage(), undefined, {
    cachePath: await modelDirectory(),
  })
  const totals = {
    png: { encodeMs: 0, recognizeMs: 0, bytes: 0 },
    pgm: { encodeMs: 0, recognizeMs: 0, bytes: 0 },
  }
  let pages = 0
  let identical = 0
  try {
    for await (const { canvas } of pagesOf(scanned, 2)) {
      const results: Record<string, TessWord[]> = {}
      for (const format of ["png", "pgm"] as const) {
        const began = performance.now()
        const image = encodeRaster(canvas, format)
        const encoded = performance.now()
        const { data } = await worker.recognize(image, {}, { blocks: true })
        totals[format].encodeMs += encoded - began
        totals[format].recognizeMs += performance.now() - encoded
        totals[format].bytes += image.length
        results[format] = wordsOf(data)
      }
      pages += 1
      if (JSON.stringify(results.png) === JSON.stringify(results.pgm))
        identical += 1
    }
  } finally {
    await worker.terminate()
  }
  console.log(`\n## Hand-off, ${pages} pages at 2x, one worker\n`)
  console.log("| Format | Encode ms/page | Recognize ms/page | Size/page | |")
  console.log("| --- | ---: | ---: | ---: | --- |")
  for (const format of ["png", "pgm"] as const) {
    const t = totals[format]
    console.log(
      `| ${format.toUpperCase()} | ${(t.encodeMs / pages).toFixed(1)} | ${(t.recognizeMs / pages).toFixed(0)} | ${(t.bytes / pages / 1024).toFixed(0)} KiB | |`
    )
  }
  console.log(`\nIdentical words and boxes: ${identical} of ${pages} pages`)
}

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, "")
const tokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)

function score(document: LabelledDocument, read: string) {
  const haystack = squash(read)
  const values = document.spans
    .map((span) => span.value)
    .filter((v) => v.trim())
  const found = values.filter((value) =>
    haystack.includes(squash(value))
  ).length

  const seen = new Map<string, number>()
  for (const token of tokens(read)) seen.set(token, (seen.get(token) ?? 0) + 1)
  let matched = 0
  const truth = tokens(document.text)
  for (const token of truth) {
    const left = seen.get(token) ?? 0
    if (left > 0) {
      matched += 1
      seen.set(token, left - 1)
    }
  }
  return { values: values.length, found, words: truth.length, matched }
}

async function ocrScan(scan: Scan, scale: number) {
  const pdfjs = await loadPdfjsForRender()
  const { task } = await openPdfDocument(pdfjs, scan.pdf)
  const pdf = await task.promise
  const session = await tesseractProvider.start()
  try {
    const pageNumbers = Array.from({ length: pdf.numPages }, (_, i) => i + 1)
    const read = await ocrPdfPages(pdf, pageNumbers, {
      scale,
      recognize: (image) => session.recognize(image),
      format: session.rasterFormat ?? "png",
    })
    return [...read.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, result]) => result.text)
      .join("\n")
  } finally {
    await session.close()
    await task.destroy()
  }
}

async function scaleStudy(scanned: Scan[], scales: number[]) {
  console.log(`\n## Render scale, ${scanned.length} documents\n`)
  console.log(
    "| Scale | Labelled values found | Words read | ms/page | Peak RSS |"
  )
  console.log("| ---: | ---: | ---: | ---: | ---: |")
  for (const scale of scales) {
    peakRss = 0
    const totals = {
      values: 0,
      found: 0,
      words: 0,
      matched: 0,
      pages: 0,
      ms: 0,
    }
    for (const scan of scanned) {
      const began = performance.now()
      const read = await ocrScan(scan, scale)
      totals.ms += performance.now() - began
      totals.pages += scan.pages
      const s = score(scan.document, read)
      totals.values += s.values
      totals.found += s.found
      totals.words += s.words
      totals.matched += s.matched
    }
    console.log(
      `| ${scale} | ${((100 * totals.found) / totals.values).toFixed(1)}% (${totals.found}/${totals.values}) | ${((100 * totals.matched) / totals.words).toFixed(1)}% | ${(totals.ms / totals.pages).toFixed(0)} | ${mib(peakRss)} |`
    )
  }
}

/**
 * OCR as it was before #189: a worker started for the document and
 * terminated after it, every page drawn, encoded as PNG and read before the
 * next is drawn.
 */
async function ocrScanBefore(scan: Scan, scale: number) {
  const { createWorker } = await import("tesseract.js")
  const worker = await createWorker(tesseractLanguage(), undefined, {
    cachePath: await modelDirectory(),
  })
  const pdfjs = await loadPdfjsForRender()
  const { task } = await openPdfDocument(pdfjs, scan.pdf)
  const pdf = await task.promise
  const texts: string[] = []
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      const png = (await renderPage(page, scale)).canvas.toBuffer("image/png")
      page.cleanup()
      const { data } = await worker.recognize(png, {}, { blocks: true })
      texts.push(data.text ?? "")
    }
  } finally {
    await worker.terminate()
    await task.destroy()
  }
  return texts.join("\n")
}

async function throughput(scanned: Scan[]) {
  const pages = (list: readonly Scan[]) =>
    list.reduce((sum, scan) => sum + scan.pages, 0)
  console.log(
    `\n## Throughput at scale 2 (${os.availableParallelism()} CPUs)\n`
  )
  console.log("| Path | Run | Pages | Pages/minute | Peak RSS |")
  console.log("| --- | --- | ---: | ---: | ---: |")

  const runs = [
    ["one document", scanned.slice(0, 1), 1],
    [`${scanned.length} documents at once`, scanned, scanned.length],
  ] as const

  for (const [path, read] of [
    ["before", ocrScanBefore],
    ["now", ocrScan],
  ] as const) {
    // The pool is warmed first, as it is in a running server; the old path
    // started a worker per document, so starting one is part of its time.
    if (path === "now") await ocrScan(scanned[0], 2)
    for (const [label, list, together] of runs) {
      peakRss = 0
      const began = performance.now()
      await mapWithConcurrency([...list], together, (scan) => read(scan, 2))
      const minutes = (performance.now() - began) / 60_000
      console.log(
        `| ${path} | ${label} | ${pages(list)} | ${(pages(list) / minutes).toFixed(1)} | ${mib(peakRss)} |`
      )
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      part: { type: "string", default: "all" },
      docs: { type: "string", default: "12" },
      scales: { type: "string", default: "1.5,2,2.5" },
    },
  })
  const count = Number(values.docs)
  const scales = values.scales.split(",").map(Number)
  const part = values.part

  const scanned = await scans(count)
  console.log(
    `Scanned ${scanned.length} corpus documents (${scanned.reduce((s, x) => s + x.pages, 0)} pages) at 200 DPI.`
  )

  if (part === "all" || part === "handoff") await handoff(scanned)
  if (part === "all" || part === "scale") await scaleStudy(scanned, scales)
  if (part === "all" || part === "throughput") await throughput(scanned)
  await closeTesseractPools()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
