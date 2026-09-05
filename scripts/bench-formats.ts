/**
 * Extraction and export, timed over deliberately large documents.
 *
 *   pnpm bench
 *   pnpm bench --only=eml,csv
 *
 * Not a benchmark in the "which is faster" sense — there is nothing to compare
 * against. It exists to catch the shape of the curve. Every pipeline here does
 * two things that are easy to write quadratically: mapping a set of accepted
 * ranges onto a set of source positions, and applying a set of edits to a
 * string. Both are fine on a memo and both are minutes on a real document, and
 * neither shows up in a unit test because unit fixtures are small.
 *
 * So each case is sized to where a person would actually notice, every value
 * the deterministic detectors find is accepted, and the export runs the real
 * path including its verification gate. A row that suddenly takes ten times
 * longer is the signal; the absolute numbers depend on the machine.
 *
 * Fixtures are synthetic and built here. No real personal data.
 */

import { extractDelimited } from "@/lib/documents/delimited/extract"
import { extractEml } from "@/lib/documents/eml/extract"
import { extractPptx } from "@/lib/documents/pptx/extract"
import { extractRtf } from "@/lib/documents/rtf/extract"
import { extractText } from "@/lib/documents/text/extract"
import { detectPatterns } from "@/lib/redaction/detectors"
import { exportRedacted } from "@/lib/redaction/export"
import type { DocumentKind, NormalizedDocument } from "@/types/document"
import type { Redaction } from "@/types/redaction"

const PERSON = "John Smith"
const EMAIL = "john@example.com"
const PHONE = "+1 (415) 555-0132"

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function latin1(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "latin1"))
}

// --- fixtures ---------------------------------------------------------------

/** 20 000 rows, an address in every one of them. */
function largeCsv(): Uint8Array {
  const rows = ["name,email,phone,note"]
  for (let index = 0; index < 20_000; index++) {
    rows.push(
      `${PERSON} ${index},user${index}@example.com,${PHONE},"note, with a comma"`
    )
  }
  return encode(`${rows.join("\n")}\n`)
}

/** ~4 MB of prose with an address every tenth line. */
function largeTxt(): Uint8Array {
  const lines: string[] = []
  for (let index = 0; index < 60_000; index++) {
    lines.push(
      index % 10 === 0
        ? `Contact ${index}: ${EMAIL} or ${PHONE}`
        : `Line ${index}. Ordinary prose that exists to take up room on the page.`
    )
  }
  return encode(`${lines.join("\n")}\n`)
}

/** The same, as RTF, with every address split across a formatting group. */
function largeRtf(): Uint8Array {
  const body: string[] = []
  for (let index = 0; index < 20_000; index++) {
    body.push(
      index % 10 === 0
        ? `Contact ${index}: jo{\\b hn}@example.com\\par `
        : `Line ${index}. Ordinary prose taking up room.\\par `
    )
  }
  return latin1(
    `{\\rtf1\\ansi{\\fonttbl{\\f0 Times New Roman;}}\\pard ${body.join("")}}`
  )
}

/** A long thread: one message, a hundred quoted replies, several parts. */
function largeEml(): Uint8Array {
  const quoted: string[] = []
  for (let index = 0; index < 2_000; index++) {
    quoted.push(`> On day ${index}, ${PERSON} <${EMAIL}> wrote:`)
    quoted.push(`> My number is ${PHONE}.`)
  }

  const html: string[] = ["<html><body>"]
  for (let index = 0; index < 2_000; index++) {
    html.push(
      `<p>Reply ${index}: <a href="mailto:${EMAIL}">jo<span>hn</span>@example.com</a></p>`
    )
  }
  html.push("</body></html>")

  return latin1(
    [
      `From: ${PERSON} <${EMAIL}>`,
      "To: reviewer@example.com",
      "Subject: A long thread",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="bench"',
      "",
      "--bench",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      ...quoted,
      "",
      "--bench",
      'Content-Type: text/html; charset="utf-8"',
      "",
      ...html,
      "",
      "--bench--",
      "",
    ].join("\r\n")
  )
}

/** A multipart message carrying a megabyte of attachment. */
function attachmentEml(): Uint8Array {
  const payload = Buffer.alloc(1024 * 1024, 0x41).toString("base64")
  const wrapped: string[] = []
  for (let index = 0; index < payload.length; index += 76) {
    wrapped.push(payload.slice(index, index + 76))
  }

  return latin1(
    [
      `From: ${PERSON} <${EMAIL}>`,
      "To: reviewer@example.com",
      "Subject: With an attachment",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="bench"',
      "",
      "--bench",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      `Call ${PERSON} on ${PHONE}.`,
      "",
      "--bench",
      "Content-Type: application/octet-stream",
      `Content-Disposition: attachment; filename="report-${PERSON}.bin"`,
      "Content-Transfer-Encoding: base64",
      "",
      ...wrapped,
      "",
      "--bench--",
      "",
    ].join("\r\n")
  )
}

/** 200 slides, each with an address split across runs, plus notes. */
async function largePptx(): Promise<Uint8Array> {
  const { zipSync } = await import("fflate")
  const bytes = (value: string) => new Uint8Array(Buffer.from(value, "utf8"))
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const NS =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
  const REL =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

  const paragraph = (runs: string[]) =>
    `<a:p>${runs
      .map((text) => `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`)
      .join("")}</a:p>`

  const slide = (index: number) =>
    `${XML}<p:sld ${NS}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
    "<p:txBody><a:bodyPr/><a:lstStyle/>" +
    Array.from({ length: 12 }, (_unused, line) =>
      paragraph([
        `Slide ${index} line ${line}: `,
        "jo",
        "hn@exa",
        "mple.com",
        ` and ${PHONE}`,
      ])
    ).join("") +
    "</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr/></p:sld>"

  const slides = 200
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": bytes(
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>'
    ),
    "_rels/.rels": bytes(
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
    ),
    "ppt/presentation.xml": bytes(
      `${XML}<p:presentation ${NS}><p:sldIdLst>` +
        Array.from(
          { length: slides },
          (_unused, index) =>
            `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`
        ).join("") +
        '</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>'
    ),
    "ppt/_rels/presentation.xml.rels": bytes(
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        Array.from(
          { length: slides },
          (_unused, index) =>
            `<Relationship Id="rId${index + 1}" Type="${REL}/slide" Target="slides/slide${index + 1}.xml"/>`
        ).join("") +
        "</Relationships>"
    ),
  }

  for (let index = 1; index <= slides; index++) {
    files[`ppt/slides/slide${index}.xml`] = bytes(slide(index))
  }

  return zipSync(files, { level: 6 })
}

// --- the run ----------------------------------------------------------------

type BenchCase = {
  name: string
  kind: DocumentKind
  source: () => Promise<Uint8Array> | Uint8Array
  extract: (
    bytes: Uint8Array
  ) => Promise<NormalizedDocument> | NormalizedDocument
}

const CASES: BenchCase[] = [
  {
    name: "csv",
    kind: "csv",
    source: largeCsv,
    extract: (bytes) => extractDelimited("bench", "csv", bytes).document,
  },
  {
    name: "txt",
    kind: "txt",
    source: largeTxt,
    extract: (bytes) => extractText("bench", bytes).document,
  },
  {
    name: "rtf",
    kind: "rtf",
    source: largeRtf,
    extract: (bytes) => extractRtf("bench", bytes).document,
  },
  {
    name: "eml",
    kind: "eml",
    source: largeEml,
    extract: (bytes) => extractEml("bench", bytes).document,
  },
  {
    name: "eml-attachment",
    kind: "eml",
    source: attachmentEml,
    extract: (bytes) => extractEml("bench", bytes).document,
  },
  {
    name: "pptx",
    kind: "pptx",
    source: largePptx,
    extract: (bytes) => extractPptx("bench", bytes).document,
  },
]

/** Accepts everything the deterministic detectors propose. */
function acceptAll(model: NormalizedDocument): Redaction[] {
  const redactions: Redaction[] = []

  for (const page of model.pages) {
    for (const detection of detectPatterns(page.text, { page: page.number })) {
      redactions.push({
        id: `bench-${redactions.length}`,
        documentId: "bench",
        type: "text",
        source: "ai",
        category: detection.category,
        status: "accepted",
        page: detection.page,
        text: detection.text,
        start: detection.start,
        end: detection.end,
      })
    }
  }

  for (const sheet of model.sheets ?? []) {
    for (const cell of sheet.cells) {
      if (!cell.value) continue
      for (const detection of detectPatterns(cell.value, {})) {
        redactions.push({
          id: `bench-${redactions.length}`,
          documentId: "bench",
          type: "cell",
          source: "ai",
          category: detection.category,
          status: "accepted",
          text: detection.text,
          worksheet: sheet.name,
          row: cell.row,
          column: cell.column,
        })
      }
    }
  }

  return redactions
}

function since(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

async function main(): Promise<void> {
  const only = process.argv
    .find((argument) => argument.startsWith("--only="))
    ?.slice("--only=".length)
    .split(",")
    .map((name) => name.trim())

  const selected = only
    ? CASES.filter((benchCase) => only.includes(benchCase.name))
    : CASES

  console.log(
    "case            size       extract    detect+plan   export     total   redactions"
  )
  console.log("".padEnd(84, "-"))

  for (const benchCase of selected) {
    const source = await benchCase.source()

    const extractStarted = process.hrtime.bigint()
    const model = await benchCase.extract(source)
    const extractMs = since(extractStarted)

    const detectStarted = process.hrtime.bigint()
    const redactions = acceptAll(model)
    const detectMs = since(detectStarted)

    const exportStarted = process.hrtime.bigint()
    const result = await exportRedacted({
      kind: benchCase.kind,
      source,
      model,
      redactions,
      options: { addLabels: false, sanitizeMetadata: true },
    })
    const exportMs = since(exportStarted)

    if (!result.verification.passed) {
      throw new Error(`${benchCase.name}: the export did not verify`)
    }

    console.log(
      [
        benchCase.name.padEnd(15),
        megabytes(source.byteLength).padEnd(10),
        `${extractMs.toFixed(0)} ms`.padEnd(10),
        `${detectMs.toFixed(0)} ms`.padEnd(13),
        `${exportMs.toFixed(0)} ms`.padEnd(10),
        `${(extractMs + detectMs + exportMs).toFixed(0)} ms`.padEnd(8),
        String(redactions.length),
      ].join(" ")
    )
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
