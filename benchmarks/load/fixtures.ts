/**
 * The files a load test uploads (#190): a mix of the formats people send,
 * made from the synthetic corpus so no real personal data is involved.
 *
 * The corpus renders to born-digital PDF, DOCX, XLSX and EML directly. It has
 * no scans and no photographs, and those are the expensive ones, so two more
 * are made the way `pnpm bench:ocr` makes them: a PDF's pages rasterised at
 * scanner resolution and put back with no text layer, and a first page saved
 * as a PNG. Both go through OCR on the server.
 *
 * Everything is built once and cached under benchmarks/load/.cache/, which git
 * ignores; the same corpus gives the same bytes every time.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { PDFDocument } from "pdf-lib"

import {
  loadPdfjsForRender,
  openPdfDocument,
  renderPage,
} from "@/lib/documents/pdf/render"

import { renderDocument } from "../corpus/lib/render"
import type { LabelledDocument } from "../corpus/lib/types"
import { loadCorpus } from "../lib/corpus"

const HERE = import.meta.dirname
const CORPUS = path.join(HERE, "..", "corpus", "synthetic-v1")
const CACHE = path.join(HERE, ".cache")

/** A scanner's usual resolution, in PDF units (72 per inch). */
const SCAN_SCALE = 200 / 72
/** A phone photo of a page is about this sharp once downscaled. */
const IMAGE_SCALE = 150 / 72

export const LOAD_FORMATS = [
  "pdf",
  "scan",
  "docx",
  "xlsx",
  "eml",
  "image",
] as const
export type LoadFormat = (typeof LOAD_FORMATS)[number]

export function isLoadFormat(value: string): value is LoadFormat {
  return (LOAD_FORMATS as readonly string[]).includes(value)
}

export type Fixture = {
  format: LoadFormat
  /** The corpus document it was made from. */
  source: string
  filename: string
  contentType: string
  bytes: Uint8Array
}

const CONTENT_TYPE: Record<LoadFormat, string> = {
  pdf: "application/pdf",
  scan: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  eml: "message/rfc822",
  image: "image/png",
}

const EXTENSION: Record<LoadFormat, string> = {
  pdf: "pdf",
  scan: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  eml: "eml",
  image: "png",
}

/** Which corpus rendering a load format starts from. */
const BASE: Record<LoadFormat, "pdf" | "docx" | "xlsx" | "eml"> = {
  pdf: "pdf",
  scan: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  eml: "eml",
  image: "pdf",
}

async function rasterise(
  pdf: Uint8Array,
  scale: number,
  firstPageOnly: boolean
): Promise<Buffer[]> {
  const pdfjs = await loadPdfjsForRender()
  const { task } = await openPdfDocument(pdfjs, pdf)
  const source = await task.promise
  const pages: Buffer[] = []
  try {
    const last = firstPageOnly ? 1 : source.numPages
    for (let number = 1; number <= last; number++) {
      const page = await source.getPage(number)
      const { canvas } = await renderPage(page, scale)
      page.cleanup()
      pages.push(canvas.toBuffer("image/png"))
    }
  } finally {
    await task.destroy()
  }
  return pages
}

/** A born-digital PDF, as a scan: every page an image, no text layer. */
async function scanOf(pdf: Uint8Array): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  for (const png of await rasterise(pdf, SCAN_SCALE, false)) {
    const image = await output.embedPng(png)
    output.addPage([image.width, image.height]).drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    })
  }
  return output.save()
}

async function make(
  document: LabelledDocument,
  format: LoadFormat
): Promise<Uint8Array> {
  const rendered = await renderDocument(document, BASE[format])
  if (format === "scan") return scanOf(rendered.bytes)
  if (format === "image")
    return new Uint8Array(
      (await rasterise(rendered.bytes, IMAGE_SCALE, true))[0]
    )
  return rendered.bytes
}

/**
 * `perFormat` files of each format asked for, each from a different corpus
 * document where the corpus has enough. Medium-length documents only: a short
 * one is a page and says little about throughput, and the long ones would
 * make every run about the few that happen to be picked.
 */
export async function loadFixtures(
  formats: readonly LoadFormat[],
  perFormat: number,
  log: (message: string) => void = () => {}
): Promise<Fixture[]> {
  const corpus = (await loadCorpus(CORPUS, "dev"))
    .filter((document) => document.length === "medium")
    .sort((a, b) => a.id.localeCompare(b.id))

  const fixtures: Fixture[] = []
  for (const format of formats) {
    const candidates = corpus.filter((document) =>
      document.render.includes(BASE[format])
    )
    if (candidates.length === 0)
      throw new Error(`the corpus has no document that renders to ${format}`)
    for (let index = 0; index < perFormat; index++) {
      const document = candidates[index % candidates.length]
      const filename = `${document.id}-${format}.${EXTENSION[format]}`
      const cached = path.join(CACHE, format, filename)
      let bytes: Uint8Array
      if (existsSync(cached)) {
        bytes = new Uint8Array(await readFile(cached))
      } else {
        log(`making ${filename}`)
        bytes = await make(document, format)
        await mkdir(path.dirname(cached), { recursive: true })
        await writeFile(cached, bytes)
      }
      fixtures.push({
        format,
        source: document.id,
        filename,
        contentType: CONTENT_TYPE[format],
        bytes,
      })
    }
  }
  return fixtures
}
