import { randomBytes } from "node:crypto"

import { unzipSync, zipSync } from "fflate"
import { PDFDocument, StandardFonts } from "pdf-lib"

import { serializeNormalized } from "@/lib/documents/normalized-json"
import { openPackageFromArchive } from "@/lib/documents/ooxml/package"
import { openZip } from "@/lib/documents/ooxml/zip"
import { renderPagesForVision } from "@/lib/documents/pdf/page-images"
import { MimeScanner } from "@/lib/documents/eml/scan"
import { extractText } from "@/lib/documents/text/extract"
import { bufferRangeSource, type RangeSource } from "@/lib/storage/range-source"

/**
 * The byte counts behind the figures in docs/streaming.md.
 *
 *   pnpm tsx scripts/streaming-figures.ts
 *
 * Every number here is a count of bytes a code path reads, decodes or holds,
 * over a generated fixture — deterministic, so a later run can be compared
 * and the doc checked against it. None of it is a memory profile of a running
 * process; the doc says which of its figures are these counts and which are
 * modelled from them.
 */

const MiB = 1024 * 1024

function counting(source: RangeSource) {
  let read = 0
  return {
    source: {
      size: source.size,
      range: async (start: number, end: number) => {
        read += end - start
        return source.range(start, end)
      },
    } satisfies RangeSource,
    read: () => read,
  }
}

async function textModel() {
  const lines = Array.from(
    { length: 100_000 },
    (_, index) => `Line ${index}: John Smith, 12 Acacia Avenue, account 40-${index}`
  ).join("\n")
  const { document } = extractText("doc", new Uint8Array(Buffer.from(lines)))
  const { json, index } = serializeNormalized(document)
  const pages = index.pages.map(([, start, end]) => end - start)
  const outline = index.open + 1 + (index.size - index.close)
  return {
    pages: pages.length,
    modelBytes: Buffer.byteLength(json),
    largestPageBytes: Math.max(...pages),
    outlineBytes: outline,
  }
}

async function pdfVision() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 1000; number++) {
    const page = pdf.addPage([612, 792])
    for (let line = 0; line < 40; line++) {
      page.drawText(`Page ${number}, line ${line}: ${"filler text ".repeat(6)}`, {
        x: 40,
        y: 750 - line * 18,
        size: 8,
        font,
      })
    }
  }
  const bytes = await pdf.save()
  const { source, read } = counting(bufferRangeSource(bytes))
  await renderPagesForVision(source, [500], 0.5)
  return { fileBytes: bytes.byteLength, readForOnePage: read() }
}

async function deck() {
  const text = new TextEncoder().encode(
    `<p:sld><p:txBody>${"<a:t>John Smith</a:t>".repeat(2000)}</p:txBody></p:sld>`
  )
  // Photographs do not compress; random bytes do not either.
  const photo = new Uint8Array(randomBytes(8 * MiB))
  const bytes = zipSync(
    {
      "ppt/presentation.xml": new TextEncoder().encode("<p:presentation/>"),
      "ppt/slides/slide1.xml": text,
      "ppt/slides/slide2.xml": text,
      "ppt/media/image1.jpeg": photo,
      "ppt/media/image2.jpeg": photo.slice().reverse(),
    },
    { level: 6 }
  )
  const whole = Object.values(unzipSync(bytes)).reduce((total, part) => total + part.byteLength, 0)
  const pkg = await openPackageFromArchive(await openZip(bufferRangeSource(bytes)))
  let held = 0
  for (const name of Object.keys(pkg.files)) {
    try {
      held += pkg.files[name].byteLength
    } catch {
      // A part let go; it is not held.
    }
  }
  return { fileBytes: bytes.byteLength, inflatedWhole: whole, heldRanged: held }
}

function message() {
  const attachment = Buffer.alloc(24 * MiB, 7).toString("base64").replace(/(.{76})/g, "$1\r\n")
  const source = [
    "From: John Smith <john@example.com>",
    "To: jane@example.com",
    "Subject: The contract",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain",
    "",
    "Please find the contract attached.",
    "--b1",
    'Content-Type: application/pdf; name="contract.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    attachment,
    "--b1--",
    "",
  ].join("\r\n")
  const scanner = new MimeScanner()
  const window = (scanner as unknown as { window: { text: string } }).window
  let peak = 0
  for (let at = 0; at < source.length; at += 1 * MiB) {
    scanner.write(source.slice(at, at + MiB))
    peak = Math.max(peak, window.text.length)
  }
  scanner.end()
  // Measured between pieces: what the scanner keeps once it has consumed one,
  // on top of the piece it is being handed.
  return { messageBytes: source.length, retainedBetweenPieces: peak }
}

async function main() {
  const figures = {
    textModel: await textModel(),
    pdfVision: await pdfVision(),
    deck: await deck(),
    message: message(),
  }
  console.log(JSON.stringify(figures, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
