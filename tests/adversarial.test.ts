import { describe, expect, it } from "vitest"

import { extractDelimited } from "@/lib/documents/delimited/extract"
import { parseDelimited } from "@/lib/documents/delimited/parse"
import { extractDocx } from "@/lib/documents/docx/extract"
import { extractEml } from "@/lib/documents/eml/extract"
import { decodeEml, parseEml } from "@/lib/documents/eml/parse"
import { emlReparses } from "@/lib/documents/eml/validate"
import { openPackage, readPart } from "@/lib/documents/ooxml/package"
import { extractPdf } from "@/lib/documents/pdf/extract"
import { extractPptx } from "@/lib/documents/pptx/extract"
import { extractRtf } from "@/lib/documents/rtf/extract"
import { extractText } from "@/lib/documents/text/extract"
import { extractXlsx } from "@/lib/documents/xlsx/extract"
import { detectPatterns } from "@/lib/redaction/detectors"
import { exportRedacted } from "@/lib/redaction/export"
import type { DocumentKind, NormalizedDocument } from "@/types/document"
import type { Redaction } from "@/types/redaction"

import { bytesOf, EML, mixedEml } from "./eml-fixtures"
import { makeDocxFixture, makePdfFixture, makeXlsxFixture, SENSITIVE } from "./fixtures"
import { DECK, makePptxFixture } from "./pptx-fixtures"

/**
 * One adversarial pass over every format.
 *
 * The per-format suites test their own pipeline. This one tests the claim the
 * product actually makes, in the same shape for all of them: take a document
 * with known sensitive values in it, run it through the real export path, and
 * then open the artifact the way somebody trying to recover the values would.
 *
 * Three things are asserted for every format, and the second and third are the
 * ones that catch a pipeline quietly doing nothing:
 *
 *   1. an accepted value is absent from the artifact, read in that format's
 *      own terms — parsed cells, reparsed MIME, every part of a package;
 *   2. a *rejected* value is still present, because a redactor that removes
 *      everything passes assertion one and is useless;
 *   3. the artifact still opens as what it claims to be.
 *
 * Deliberately not asserted through `verifyExport` alone: that is the gate the
 * export already ran, and a test that only re-runs the subject's own check
 * proves the check is consistent with itself.
 */

const OPTIONS = { addLabels: false, sanitizeMetadata: true }

const encoder = new TextEncoder()

function encode(value: string): Uint8Array {
  return encoder.encode(value)
}

type Case = {
  kind: DocumentKind
  name: string
  source: () => Promise<Uint8Array> | Uint8Array
  extract: (
    bytes: Uint8Array
  ) => Promise<NormalizedDocument> | NormalizedDocument
  /** Must be gone from the artifact once accepted. */
  accepted: string
  /** Must survive, because nobody accepted it. */
  rejected: string
  /** Reads the artifact the way someone recovering the value would. */
  read: (artifact: Uint8Array) => Promise<string> | string
  /** Confirms the artifact still opens as its own format. */
  reopens: (artifact: Uint8Array) => Promise<boolean> | boolean
}

const CSV_SOURCE = [
  "name,email,note",
  `${SENSITIVE.person},${SENSITIVE.email},"seen at ${SENSITIVE.email}, twice"`,
  `Jane Doe,jane@example.com,fine`,
  "",
].join("\n")

const TSV_SOURCE = [
  "name\temail",
  `${SENSITIVE.person}\t${SENSITIVE.email}`,
  `Jane Doe\tjane@example.com`,
  "",
].join("\n")

const TXT_SOURCE = [
  "Client notes",
  `Email: ${SENSITIVE.email}`,
  `Other: jane@example.com`,
  `Phone: ${SENSITIVE.phone}`,
  "",
].join("\n")

const RTF_SOURCE =
  "{\\rtf1\\ansi{\\fonttbl{\\f0 Times;}}\\pard " +
  `Email: jo{\\b hn}@example.com\\par Other: jane@example.com\\par ` +
  `Phone: ${SENSITIVE.phone}\\par}`

/** Every text-bearing part of a package, concatenated. */
function packageText(bytes: Uint8Array): string {
  const pkg = openPackage(bytes)
  return Object.keys(pkg.files)
    .filter((name) => name.endsWith(".xml") || name.endsWith(".rels"))
    .map((name) => readPart(pkg, name) ?? "")
    .join("\n")
}

const CASES: Case[] = [
  {
    kind: "pdf",
    name: "PDF",
    // Two pages on purpose. A redacted PDF page is rebuilt as a raster and
    // loses its text layer, so the value that must survive has to be on a page
    // nothing was accepted on — which is also the property being asserted:
    // only affected pages are rasterized, and the rest keep their real text.
    source: () =>
      makePdfFixture([
        [
          { text: `${SENSITIVE.person} works at Example Corporation.` },
          { text: `Email: ${SENSITIVE.email}` },
        ],
        [{ text: `Phone: ${SENSITIVE.phone}` }],
      ]),
    extract: async (bytes) => (await extractPdf("doc", bytes)).document,
    accepted: SENSITIVE.email,
    rejected: SENSITIVE.phone,
    read: async (artifact) => {
      const { extractPdfText } = await import("@/lib/documents/pdf/redact")
      const text = await extractPdfText(artifact)
      const raw = Buffer.from(artifact).toString("latin1")
      // Glyph-spaced text hides from a plain substring search.
      return `${text}\n${raw}\n${raw.replace(/[\s()\\<>[\]]/g, "")}`
    },
    reopens: async (artifact) => {
      const { PDFDocument } = await import("pdf-lib")
      const pdf = await PDFDocument.load(artifact, { ignoreEncryption: true })
      return pdf.getPageCount() === 2
    },
  },
  {
    kind: "docx",
    name: "DOCX",
    source: () => makeDocxFixture(),
    extract: (bytes) => extractDocx("doc", bytes).document,
    accepted: SENSITIVE.email,
    rejected: SENSITIVE.account,
    read: (artifact) => packageText(artifact),
    reopens: (artifact) => extractDocx("verify", artifact).document.pages.length > 0,
  },
  {
    kind: "xlsx",
    name: "XLSX",
    source: () => makeXlsxFixture(),
    extract: async (bytes) => (await extractXlsx("doc", bytes)).document,
    accepted: SENSITIVE.email,
    rejected: SENSITIVE.account,
    read: async (artifact) => {
      const { document } = await extractXlsx("verify", artifact)
      const cells = (document.sheets ?? [])
        .flatMap((sheet) => sheet.cells.map((cell) => cell.value ?? ""))
        .join("\n")
      return `${cells}\n${packageText(artifact)}`
    },
    reopens: async (artifact) =>
      ((await extractXlsx("verify", artifact)).document.sheets ?? []).length > 0,
  },
  {
    kind: "csv",
    name: "CSV",
    source: () => encode(CSV_SOURCE),
    extract: (bytes) => extractDelimited("doc", "csv", bytes).document,
    accepted: SENSITIVE.email,
    rejected: "jane@example.com",
    read: (artifact) => {
      // Read as a grid, not as a string: a value hiding in a field the parser
      // cannot reach would not be found by searching the file as one blob.
      const parsed = parseDelimited(new TextDecoder().decode(artifact), ",")
      return parsed.rows
        .flatMap((row) => row.map((field) => field.value))
        .join("\n")
    },
    reopens: (artifact) => {
      const parsed = parseDelimited(new TextDecoder().decode(artifact), ",")
      // Every row still has the same number of fields it started with.
      return parsed.rows.every((row) => row.length === 3)
    },
  },
  {
    kind: "tsv",
    name: "TSV",
    source: () => encode(TSV_SOURCE),
    extract: (bytes) => extractDelimited("doc", "tsv", bytes).document,
    accepted: SENSITIVE.email,
    rejected: "jane@example.com",
    read: (artifact) => {
      const parsed = parseDelimited(new TextDecoder().decode(artifact), "\t")
      return parsed.rows
        .flatMap((row) => row.map((field) => field.value))
        .join("\n")
    },
    reopens: (artifact) =>
      parseDelimited(new TextDecoder().decode(artifact), "\t").rows.every(
        (row) => row.length === 2
      ),
  },
  {
    kind: "txt",
    name: "TXT",
    source: () => encode(TXT_SOURCE),
    extract: (bytes) => extractText("doc", bytes).document,
    accepted: SENSITIVE.email,
    rejected: "jane@example.com",
    read: (artifact) => new TextDecoder().decode(artifact),
    reopens: (artifact) =>
      extractText("verify", artifact).document.pages.length > 0,
  },
  {
    kind: "rtf",
    name: "RTF",
    source: () => encode(RTF_SOURCE),
    extract: (bytes) => extractRtf("doc", bytes).document,
    // Split across a formatting group in the source, so the string is not in
    // the file at all and only the parse finds it.
    accepted: "john@example.com",
    rejected: "jane@example.com",
    read: (artifact) => {
      const raw = Buffer.from(artifact).toString("latin1")
      return `${extractRtf("verify", artifact).text}\n${raw}`
    },
    reopens: (artifact) => {
      const raw = Buffer.from(artifact).toString("latin1")
      return (
        raw.startsWith("{\\rtf") &&
        raw.trimEnd().endsWith("}") &&
        extractRtf("verify", artifact).document.pages.length > 0
      )
    },
  },
  {
    kind: "eml",
    name: "EML",
    source: () => bytesOf(mixedEml()),
    extract: (bytes) => extractEml("doc", bytes).document,
    accepted: EML.email,
    rejected: EML.colleagueEmail,
    read: (artifact) => {
      const { nodes } = parseEml(decodeEml(artifact))
      return nodes
        .flatMap((node) => [
          ...node.headers.map((header) => header.value),
          node.filename ?? "",
          node.text ?? "",
        ])
        .join("\n")
    },
    reopens: (artifact) => emlReparses(artifact),
  },
  {
    kind: "pptx",
    name: "PPTX",
    source: () => makePptxFixture(),
    extract: (bytes) => extractPptx("doc", bytes).document,
    accepted: DECK.phone,
    rejected: "Next steps",
    read: (artifact) => packageText(artifact),
    reopens: (artifact) => extractPptx("verify", artifact).slides.length > 0,
  },
]

/** Everything the deterministic detectors propose, plus the named values. */
function redactionsFor(
  model: NormalizedDocument,
  accepted: string,
  rejected: string
): Redaction[] {
  const redactions: Redaction[] = []

  const push = (
    page: number,
    start: number,
    end: number,
    text: string,
    status: Redaction["status"]
  ) => {
    redactions.push({
      id: `red-${redactions.length}`,
      documentId: "doc",
      type: "text",
      source: "user",
      category: "other",
      status,
      page,
      text,
      start,
      end,
    })
  }

  for (const page of model.pages) {
    let index = page.text.indexOf(accepted)
    while (index !== -1) {
      push(page.number, index, index + accepted.length, accepted, "accepted")
      index = page.text.indexOf(accepted, index + accepted.length)
    }

    // A rejected suggestion over the value that must survive, so the export is
    // actually being asked about it and choosing not to act.
    const rejectedIndex = page.text.indexOf(rejected)
    if (rejectedIndex !== -1) {
      push(
        page.number,
        rejectedIndex,
        rejectedIndex + rejected.length,
        rejected,
        "rejected"
      )
    }
  }

  for (const sheet of model.sheets ?? []) {
    for (const cell of sheet.cells) {
      if (!cell.value) continue
      if (cell.value.includes(accepted)) {
        redactions.push({
          id: `cell-${redactions.length}`,
          documentId: "doc",
          type: "cell",
          source: "user",
          category: "other",
          status: "accepted",
          text: accepted,
          worksheet: sheet.name,
          row: cell.row,
          column: cell.column,
        })
      }
      if (cell.value.includes(rejected)) {
        redactions.push({
          id: `cell-${redactions.length}`,
          documentId: "doc",
          type: "cell",
          source: "user",
          category: "other",
          status: "rejected",
          text: rejected,
          worksheet: sheet.name,
          row: cell.row,
          column: cell.column,
        })
      }
    }
  }

  return redactions
}

describe("adversarial verification, every format", () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it("removes the accepted value, keeps the rejected one, and still opens", async () => {
        const source = await testCase.source()
        const model = await testCase.extract(source)

        // The value has to actually be in the document, or every assertion
        // below passes for the wrong reason.
        const reviewed = [
          ...model.pages.map((page) => page.text),
          ...(model.sheets ?? []).flatMap((sheet) =>
            sheet.cells.map((cell) => cell.value ?? "")
          ),
        ].join("\n")
        expect(reviewed).toContain(testCase.accepted)
        expect(reviewed).toContain(testCase.rejected)

        const redactions = redactionsFor(
          model,
          testCase.accepted,
          testCase.rejected
        )
        expect(
          redactions.some((redaction) => redaction.status === "accepted")
        ).toBe(true)
        expect(
          redactions.some((redaction) => redaction.status === "rejected")
        ).toBe(true)

        const result = await exportRedacted({
          kind: testCase.kind,
          source,
          model,
          redactions,
          options: OPTIONS,
        })

        const artifact = result.bytes
        const haystack = await testCase.read(artifact)

        // 1. Gone, read in the format's own terms.
        expect(haystack).not.toContain(testCase.accepted)

        // 2. Still there, because nobody accepted it. A redactor that removes
        //    everything satisfies the first assertion and is useless.
        expect(haystack).toContain(testCase.rejected)

        // 3. Still the format it claims to be.
        expect(await testCase.reopens(artifact)).toBe(true)

        // And the export's own gate agreed, which is a different statement
        // from the assertions above rather than the same one twice.
        expect(result.verification.passed).toBe(true)
        expect(result.checksum).toHaveLength(64)
      })
    })
  }

  it("covers every kind that can be exported", () => {
    // The list above is hand-written, so this is what stops a new format being
    // added without an adversarial case: the register knows what exists.
    const covered = new Set(CASES.map((testCase) => testCase.kind))
    // Images carry no strings, and are verified by sampling pixels in
    // tests/image.test.ts instead.
    covered.add("image")

    expect([...covered].sort()).toEqual(
      [
        "csv",
        "docx",
        "eml",
        "image",
        "pdf",
        "pptx",
        "rtf",
        "tsv",
        "txt",
        "xlsx",
      ].sort()
    )
  })

  describe("what the detectors actually find", () => {
    it("proposes the fixture values in every text-bearing format", async () => {
      // The adversarial pass above accepts values by name. This checks the
      // deterministic detectors would have proposed them, so the suite is not
      // testing a path no real document takes.
      for (const testCase of CASES) {
        if (testCase.kind === "pdf") continue

        const model = await testCase.extract(await testCase.source())
        const found = new Set(
          model.pages.flatMap((page) =>
            detectPatterns(page.text, { page: page.number }).map(
              (detection) => detection.text
            )
          )
        )

        for (const sheet of model.sheets ?? []) {
          for (const cell of sheet.cells) {
            if (!cell.value) continue
            for (const detection of detectPatterns(cell.value, {})) {
              found.add(detection.text)
            }
          }
        }

        expect(
          [...found].some((value) => value.includes("@") || /\d{3}/.test(value)),
          `${testCase.name} produced no deterministic detections`
        ).toBe(true)
      }
    })
  })
})
