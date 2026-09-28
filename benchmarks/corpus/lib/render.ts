import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

import fontkit from "@pdf-lib/fontkit"
import { zipSync, type Zippable } from "fflate"
import { PDFDocument, type PDFFont } from "pdf-lib"

import type { LabelledDocument } from "./types"

/**
 * Deterministic rendering of a corpus document to the formats a person
 * uploads, so the benchmark can go through Anonify's own extraction rather
 * than hand it clean text. What is committed is the text and its labels; the
 * files are made from them when needed (issue #57), so a rendering bug is
 * fixed here without regenerating anything.
 *
 * Deterministic means the same document gives the same bytes on any machine:
 * no dates, no random identifiers, and zip entries with a fixed timestamp.
 * DOCX and XLSX are written as the smallest packages Word and Excel open,
 * rather than through a library that stamps the current time into them.
 *
 * The text is rendered as it is, line for line. A character a format cannot
 * carry (a control character in XML, a glyph the font lacks) becomes "?", and
 * the count is returned: the scorer aligns what extraction gives back with the
 * original text, so such a character simply goes unmatched.
 */

export const RENDER_FORMATS = [
  "txt",
  "eml",
  "pdf",
  "docx",
  "csv",
  "xlsx",
] as const
export type RenderFormat = (typeof RENDER_FORMATS)[number]

export function isRenderFormat(value: string): value is RenderFormat {
  return (RENDER_FORMATS as readonly string[]).includes(value)
}

export type Rendered = {
  format: RenderFormat
  filename: string
  mimeType: string
  bytes: Uint8Array
  /** Characters replaced with "?" because the format could not carry them. */
  substituted: number
}

const MIME: Record<RenderFormat, string> = {
  txt: "text/plain",
  eml: "message/rfc822",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

/** 2000-01-01, where a format insists on a date. */
const EPOCH = new Date(Date.UTC(2000, 0, 1))

export async function renderDocument(
  document: LabelledDocument,
  format: RenderFormat
): Promise<Rendered> {
  const done = (bytes: Uint8Array, substituted = 0): Rendered => ({
    format,
    filename: `${document.id}.${format}`,
    mimeType: MIME[format],
    bytes,
    substituted,
  })
  switch (format) {
    case "txt":
      return done(utf8(document.text))
    case "eml":
      return done(eml(document))
    case "csv":
      return done(csv(document))
    case "docx": {
      const { text, substituted } = xmlSafe(document.text)
      return done(docx(text), substituted)
    }
    case "xlsx": {
      let substituted = 0
      const rows = rowsOf(document).map((row) =>
        row.map((cell) => {
          const safe = xmlSafe(cell)
          substituted += safe.substituted
          return safe.text
        })
      )
      return done(xlsx(rows), substituted)
    }
    case "pdf":
      return pdf(document.text).then(({ bytes, substituted }) =>
        done(bytes, substituted)
      )
  }
}

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"))
}

// --- eml --------------------------------------------------------------------

/**
 * One text/plain message holding the document. The headers say nothing about
 * it: the title is metadata that is never rendered, and an address in a
 * header would be a value with no label. What is found there is scored as
 * outside the document.
 */
function eml(document: LabelledDocument): Uint8Array {
  const body = Buffer.from(document.text, "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n")
  const headers = [
    "From: Anonify corpus <corpus@example.invalid>",
    "To: Anonify corpus <corpus@example.invalid>",
    `Subject: ${document.id}`,
    "Date: Sat, 01 Jan 2000 00:00:00 +0000",
    `Message-ID: <${document.id}@corpus.example.invalid>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ]
  return utf8(`${headers.join("\r\n")}\r\n\r\n${body.trimEnd()}\r\n`)
}

// --- rows, for csv and xlsx -------------------------------------------------

/** RFC 4180, as the tabular exports are written. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === "") quoted = true
    else if (ch === ",") {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += ch
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""))
}

/**
 * The document as rows. A tabular export is CSV already. Anything else, such
 * as a bank statement, is a row per line, split into cells where the text
 * lines columns up: at tabs, at " | ", or at runs of two or more spaces.
 */
export function rowsOf(document: LabelledDocument): string[][] {
  if (document.docType === "tabular export") return parseCsv(document.text)
  return document.text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) =>
      line
        .split(/\t|\s+\|\s+| {2,}/)
        .map((cell) => cell.trim())
        .filter((cell, _, all) => cell !== "" || all.length === 1)
    )
}

function csvCell(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
}

function csv(document: LabelledDocument): Uint8Array {
  if (document.docType === "tabular export") return utf8(document.text)
  return utf8(
    `${rowsOf(document)
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n")}\r\n`
  )
}

// --- OOXML ------------------------------------------------------------------

/** XML 1.0 allows no control characters but tab, newline and return. */
function xmlSafe(text: string): { text: string; substituted: number } {
  let substituted = 0
  const safe = text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g,
    () => {
      substituted++
      return "?"
    }
  )
  return { text: safe, substituted }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

function zip(files: Record<string, string>): Uint8Array {
  const entries: Zippable = {}
  for (const [name, content] of Object.entries(files))
    entries[name] = [utf8(content), { mtime: EPOCH }]
  return zipSync(entries, { level: 6, mtime: EPOCH })
}

function docx(text: string): Uint8Array {
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => {
      const runs = line
        .split("\t")
        .map((part) =>
          part ? `<w:t xml:space="preserve">${escapeXml(part)}</w:t>` : ""
        )
        .join("<w:tab/>")
      return runs ? `<w:p><w:r>${runs}</w:r></w:p>` : "<w:p/>"
    })
    .join("")
  return zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`,
  })
}

function columnName(index: number): string {
  let name = ""
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/** Every cell a string, so a card number or a leading zero survives as written. */
function xlsx(rows: string[][]): Uint8Array {
  const strings: string[] = []
  const index = new Map<string, number>()
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === "") return ""
          let id = index.get(value)
          if (id === undefined) {
            id = strings.length
            strings.push(value)
            index.set(value, id)
          }
          return `<c r="${columnName(c)}${r + 1}" t="s"><v>${id}</v></c>`
        })
        .join("")
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join("")
  const shared = strings
    .map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)
    .join("")
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  const rel =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  const type = "application/vnd.openxmlformats-officedocument.spreadsheetml"
  return zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${type}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${type}.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${type}.sharedStrings+xml"/></Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${XML}<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `${XML}<sst xmlns="${main}" count="${strings.length}" uniqueCount="${strings.length}">${shared}</sst>`,
    "xl/worksheets/sheet1.xml": `${XML}<worksheet xmlns="${main}"><sheetData>${sheetRows}</sheetData></worksheet>`,
  })
}

// --- pdf --------------------------------------------------------------------

const PAGE = { width: 595.28, height: 841.89 } // A4
const MARGIN = 56
const SIZE = 10
const LEADING = 13

let fontBytes: Promise<Uint8Array> | null = null

/**
 * DejaVu Sans, from the dejavu-fonts-ttf dev dependency. The PDF standard
 * fonts carry only Latin-1, and the corpus writes rupees, ballot boxes and
 * check marks; DejaVu has a glyph for every character in it.
 */
function dejaVu(): Promise<Uint8Array> {
  fontBytes ??= (async () => {
    const require = createRequire(import.meta.url)
    const dir = path.dirname(require.resolve("dejavu-fonts-ttf/package.json"))
    return new Uint8Array(
      await readFile(path.join(dir, "ttf", "DejaVuSans.ttf"))
    )
  })()
  return fontBytes
}

/** Greedy wrapping at spaces; a word wider than the line is broken where it must be. */
function wrap(line: string, font: PDFFont, width: number): string[] {
  const fits = (text: string) => font.widthOfTextAtSize(text, SIZE) <= width
  if (fits(line)) return [line]
  const out: string[] = []
  let current = ""
  for (const word of line.split(/(?<= )/)) {
    if (fits(current + word)) {
      current += word
      continue
    }
    if (current) out.push(current.trimEnd())
    current = ""
    let rest = word
    while (!fits(rest)) {
      let cut = rest.length - 1
      while (cut > 1 && !fits(rest.slice(0, cut))) cut--
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    current = rest
  }
  if (current.trim()) out.push(current.trimEnd())
  return out
}

async function pdf(
  text: string
): Promise<{ bytes: Uint8Array; substituted: number }> {
  const document = await PDFDocument.create({ updateMetadata: false })
  document.registerFontkit(fontkit)
  const font = await document.embedFont(await dejaVu(), { subset: true })
  const supported = new Set(font.getCharacterSet())

  let substituted = 0
  // By code point, so a character outside the BMP is one "?", not two.
  const printable = text.replace(/\t/g, "    ").replace(/[^\n]/gu, (ch) => {
    if (ch === " " || supported.has(ch.codePointAt(0)!)) return ch
    substituted++
    return "?"
  })

  const width = PAGE.width - 2 * MARGIN
  let page = document.addPage([PAGE.width, PAGE.height])
  let y = PAGE.height - MARGIN
  for (const source of printable.split("\n")) {
    for (const line of source.trim() ? wrap(source, font, width) : [""]) {
      if (y < MARGIN) {
        page = document.addPage([PAGE.width, PAGE.height])
        y = PAGE.height - MARGIN
      }
      if (line.trim()) page.drawText(line, { x: MARGIN, y, size: SIZE, font })
      y -= LEADING
    }
  }
  return { bytes: await document.save(), substituted }
}
