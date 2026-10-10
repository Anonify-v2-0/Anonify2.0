/**
 * Peak memory of a large PDF export (#187).
 *
 *   pnpm exec tsx benchmarks/export-memory.ts [--mib 50] [--redacted 3]
 *
 * Builds a PDF of about `--mib` MiB (pages carrying incompressible images, so
 * the size is real), redacts `--redacted` pages of it with the exporter, and
 * reports the peak resident memory and the peak of heap plus external memory
 * above where the process started. Run it in a fresh process each time: the
 * numbers are the process's, and an earlier run's garbage would count.
 */

import { randomFillSync } from "node:crypto"
import { parseArgs } from "node:util"

import { createCanvas } from "@napi-rs/canvas"
import { PDFDocument } from "pdf-lib"

import { redactPdf } from "@/lib/documents/pdf/redact"

const { values } = parseArgs({
  options: {
    mib: { type: "string", default: "50" },
    redacted: { type: "string", default: "3" },
  },
})
const targetBytes = Number(values.mib) * 1024 * 1024
const redactedPages = Number(values.redacted)

/** A page-sized image of random pixels, which no compressor can shrink. */
function noisePng(): Buffer {
  const canvas = createCanvas(600, 600)
  const context = canvas.getContext("2d")
  const image = context.createImageData(600, 600)
  randomFillSync(image.data)
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255
  context.putImageData(image, 0, 0)
  return canvas.toBuffer("image/png")
}

async function buildPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  let size = 0
  while (size < targetBytes) {
    const png = noisePng()
    const image = await pdf.embedPng(png)
    pdf
      .addPage([595, 842])
      .drawImage(image, { x: 0, y: 0, width: 595, height: 842 })
    // pdf-lib stores the decoded pixels, deflated: noise does not shrink.
    size += 600 * 600 * 3
  }
  return pdf.save()
}

const bytes = await buildPdf()
if (global.gc) global.gc()
const start = process.memoryUsage()
let peakRss = start.rss
let peakHeap = start.heapUsed + start.external
const sampler = setInterval(() => {
  const now = process.memoryUsage()
  peakRss = Math.max(peakRss, now.rss)
  peakHeap = Math.max(peakHeap, now.heapUsed + now.external)
}, 5)

const boxesByPage = new Map(
  Array.from({ length: redactedPages }, (_, i) => [
    i + 1,
    [{ x: 50, y: 50, width: 200, height: 40 }],
  ])
)
const began = performance.now()
const output = await redactPdf(bytes, {
  boxesByPage,
  label: null,
  sanitizeMetadata: true,
})
const ms = performance.now() - began
clearInterval(sampler)

const mib = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MiB`
console.log(
  JSON.stringify({
    sourceSize: mib(bytes.byteLength),
    outputSize: mib(output.byteLength),
    redactedPages,
    ms: Math.round(ms),
    peakRssAboveStart: mib(peakRss - start.rss),
    peakHeapAndExternalAboveStart: mib(
      peakHeap - (start.heapUsed + start.external)
    ),
  })
)
