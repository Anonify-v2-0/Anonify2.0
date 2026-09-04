import { unzipSync } from "fflate"
import sharp from "sharp"
import { describe, expect, it } from "vitest"

import { extractDocx } from "@/lib/documents/docx/extract"
import { extractPdf } from "@/lib/documents/pdf/extract"
import { extractPdfText } from "@/lib/documents/pdf/redact"
import { extractXlsx } from "@/lib/documents/xlsx/extract"
import { sampleRegion } from "@/lib/documents/image/redact"
import { newRedactionId } from "@/lib/documents/ids"
import { exportRedacted } from "@/lib/redaction/export"
import { verifyExport } from "@/lib/redaction/validation"
import type { NormalizedDocument } from "@/types/document"
import type { Redaction } from "@/types/redaction"
import {
  IMAGE_BAND,
  makeDocxFixture,
  makeExifImageFixture,
  makeImageFixture,
  makePdfFixture,
  makeXlsxFixture,
  SENSITIVE,
} from "./fixtures"

/**
 * Adversarial verification.
 *
 * These tests do not check that the exporter was called correctly. They take
 * the artifact it produced and try to get the sensitive value back out of it,
 * the way someone would who wanted it: extracted text, raw bytes, every part of
 * the container, hidden sheets, stripped metadata, sampled pixels.
 */

const OPTIONS = { addLabels: false, sanitizeMetadata: true }

function accepted(overrides: Partial<Redaction>): Redaction {
  return {
    id: newRedactionId(),
    documentId: "doc_1",
    type: "text",
    source: "ai",
    category: "other",
    status: "accepted",
    ...overrides,
  }
}

function textRedaction(model: NormalizedDocument, value: string): Redaction {
  for (const page of model.pages) {
    const start = page.text.indexOf(value)
    if (start === -1) continue
    return accepted({
      page: page.number,
      text: value,
      start,
      end: start + value.length,
    })
  }
  throw new Error(`fixture does not contain ${value}`)
}

/** Every part of an OOXML package, as raw text. */
function allParts(bytes: Uint8Array): string {
  const files = unzipSync(bytes)
  return Object.entries(files)
    .map(([name, content]) => `${name}\n${Buffer.from(content).toString("utf8")}`)
    .join("\n")
}

describe("PDF: recovery attempts", () => {
  it("cannot recover the value from extracted text", async () => {
    const source = await makePdfFixture()
    const { document: model } = await extractPdf("doc_1", source)
    const { bytes } = await exportRedacted({
      kind: "pdf",
      source,
      model,
      redactions: [textRedaction(model, SENSITIVE.email)],
      options: OPTIONS,
    })

    expect(await extractPdfText(bytes)).not.toContain(SENSITIVE.email)
  })

  it("cannot recover the value by searching the raw file", async () => {
    const source = await makePdfFixture()
    const { document: model } = await extractPdf("doc_1", source)
    const { bytes } = await exportRedacted({
      kind: "pdf",
      source,
      model,
      redactions: [textRedaction(model, SENSITIVE.person)],
      options: OPTIONS,
    })

    const raw = Buffer.from(bytes).toString("latin1")
    expect(raw).not.toContain(SENSITIVE.person)
    // Nor with the spacing a PDF writer might introduce between glyphs.
    expect(raw.replace(/[\s()\\]/g, "")).not.toContain(
      SENSITIVE.person.replace(/\s/g, "")
    )
  })

  it("leaves no annotation that could be deleted to reveal the text", async () => {
    const source = await makePdfFixture()
    const { document: model } = await extractPdf("doc_1", source)
    const { bytes } = await exportRedacted({
      kind: "pdf",
      source,
      model,
      redactions: [textRedaction(model, SENSITIVE.email)],
      options: OPTIONS,
    })

    const raw = Buffer.from(bytes).toString("latin1")
    expect(raw).not.toContain("/Annots")
    expect(raw).not.toContain("/Redact")
  })

  it("re-extracts the redacted page as an image with no text objects", async () => {
    const source = await makePdfFixture()
    const { document: model } = await extractPdf("doc_1", source)
    const { bytes } = await exportRedacted({
      kind: "pdf",
      source,
      model,
      redactions: [textRedaction(model, SENSITIVE.email)],
      options: OPTIONS,
    })

    const { document: after } = await extractPdf("doc_2", bytes)
    expect(after.pages[0].spans).toHaveLength(0)
    // The page was rasterized, so extraction now flags it as needing OCR.
    expect(after.pages[0].ocr).toBe(true)
  })

  it("strips authorship metadata from the export", async () => {
    const source = await makePdfFixture()
    const { document: model } = await extractPdf("doc_1", source)
    const { bytes } = await exportRedacted({
      kind: "pdf",
      source,
      model,
      redactions: [textRedaction(model, SENSITIVE.email)],
      options: OPTIONS,
    })

    const raw = Buffer.from(bytes).toString("latin1")
    expect(raw).not.toMatch(/\/Author\s*\([^)]+\)/)
    expect(raw).not.toMatch(/\/Creator\s*\([^)]+\)/)
  })
})

describe("DOCX: recovery attempts", () => {
  it("cannot recover the value from any XML part", async () => {
    const source = await makeDocxFixture()
    const { document: model } = extractDocx("doc_1", source)
    const { bytes } = await exportRedacted({
      kind: "docx",
      source,
      model,
      redactions: [textRedaction(model, SENSITIVE.email)],
      options: OPTIONS,
    })

    expect(allParts(bytes)).not.toContain(SENSITIVE.email)
  })

  it("cannot recover a value that appeared in a table cell", async () => {
    const source = await makeDocxFixture()
    const { document: model } = extractDocx("doc_1", source)
    const { bytes } = await exportRedacted({
      kind: "docx",
      source,
      model,
      redactions: [accepted({ text: SENSITIVE.account, page: 1, start: 0, end: 0 })],
      options: OPTIONS,
    })

    expect(allParts(bytes)).not.toContain(SENSITIVE.account)
  })

  it("removes every occurrence, not just the one that was clicked", async () => {
    const source = await makeDocxFixture()
    const { document: model } = extractDocx("doc_1", source)
    const before = model.pages[0].text.split(SENSITIVE.person).length - 1
    expect(before).toBeGreaterThan(1)

    const { bytes } = await exportRedacted({
      kind: "docx",
      source,
      model,
      redactions: [textRedaction(model, SENSITIVE.person)],
      options: OPTIONS,
    })

    expect(allParts(bytes)).not.toContain(SENSITIVE.person)
  })

  it("strips authorship from docProps", async () => {
    const source = await makeDocxFixture()
    const { document: model } = extractDocx("doc_1", source)
    const { bytes } = await exportRedacted({
      kind: "docx",
      source,
      model,
      redactions: [textRedaction(model, SENSITIVE.email)],
      options: OPTIONS,
    })

    const parts = allParts(bytes)
    expect(parts).not.toMatch(/<dc:creator[^>]*>[^<]+<\/dc:creator>/)
    expect(parts).not.toMatch(/<cp:lastModifiedBy[^>]*>[^<]+<\/cp:lastModifiedBy>/)
  })

  it("still opens as a valid package afterwards", async () => {
    const source = await makeDocxFixture()
    const { document: model } = extractDocx("doc_1", source)
    const { bytes } = await exportRedacted({
      kind: "docx",
      source,
      model,
      redactions: [textRedaction(model, SENSITIVE.email)],
      options: OPTIONS,
    })

    const files = unzipSync(bytes)
    expect(files["[Content_Types].xml"]).toBeDefined()
    expect(files["word/document.xml"]).toBeDefined()
    expect(() => extractDocx("doc_2", bytes)).not.toThrow()
  })
})

describe("XLSX: recovery attempts", () => {
  it("cannot recover the value from a hidden sheet", async () => {
    const source = await makeXlsxFixture()
    const { document: model } = await extractXlsx("doc_1", source)

    const { bytes } = await exportRedacted({
      kind: "xlsx",
      source,
      model,
      redactions: [accepted({ text: SENSITIVE.email, category: "email" })],
      options: OPTIONS,
    })

    const after = await extractXlsx("doc_2", bytes)
    const archive = (after.document.sheets ?? []).find(
      (sheet) => sheet.name === "Archive"
    )
    expect(
      archive?.cells.some((cell) => cell.value?.includes(SENSITIVE.email))
    ).toBe(false)
    expect(allParts(bytes)).not.toContain(SENSITIVE.email)
  })

  it("cannot recover the value from a hidden row", async () => {
    const source = await makeXlsxFixture()
    const { document: model } = await extractXlsx("doc_1", source)

    const { bytes } = await exportRedacted({
      kind: "xlsx",
      source,
      model,
      redactions: [accepted({ text: "jane@example.com", category: "email" })],
      options: OPTIONS,
    })

    expect(allParts(bytes)).not.toContain("jane@example.com")
  })

  it("cannot recover the value through a formula or its cached result", async () => {
    const source = await makeXlsxFixture()
    const { document: model } = await extractXlsx("doc_1", source)

    const { bytes } = await exportRedacted({
      kind: "xlsx",
      source,
      model,
      redactions: [accepted({ text: SENSITIVE.email, category: "email" })],
      options: OPTIONS,
    })

    const parts = allParts(bytes)
    expect(parts).not.toContain(SENSITIVE.email)
    expect(parts).not.toContain("<f>B2</f>")
  })

  it("cannot recover the value from the shared string table", async () => {
    const source = await makeXlsxFixture()
    const { document: model } = await extractXlsx("doc_1", source)

    const { bytes } = await exportRedacted({
      kind: "xlsx",
      source,
      model,
      redactions: [accepted({ text: SENSITIVE.person, category: "person" })],
      options: OPTIONS,
    })

    const files = unzipSync(bytes)
    const shared = files["xl/sharedStrings.xml"]
    if (shared) {
      expect(Buffer.from(shared).toString("utf8")).not.toContain(
        SENSITIVE.person
      )
    }
  })

  it("strips workbook authorship", async () => {
    const source = await makeXlsxFixture()
    const { document: model } = await extractXlsx("doc_1", source)

    const { bytes } = await exportRedacted({
      kind: "xlsx",
      source,
      model,
      redactions: [accepted({ text: SENSITIVE.email, category: "email" })],
      options: OPTIONS,
    })

    expect(allParts(bytes)).not.toContain("Test Author")
  })
})

describe("images: recovery attempts", () => {
  const imageModel: NormalizedDocument = {
    documentId: "doc_1",
    kind: "image",
    pages: [{ number: 1, width: 400, height: 300, text: "", spans: [] }],
  }

  it("cannot recover the original pixels of a redacted region", async () => {
    const source = await makeImageFixture()
    const { bytes } = await exportRedacted({
      kind: "image",
      source,
      model: imageModel,
      redactions: [accepted({ type: "region", page: 1, boundingBox: IMAGE_BAND })],
      options: OPTIONS,
      mimeType: "image/png",
    })

    const sampled = await sampleRegion(bytes, IMAGE_BAND)
    expect(sampled.r + sampled.g + sampled.b).toBeLessThan(10)
  })

  it("returns a different file, not the original image", async () => {
    const source = await makeImageFixture()
    const { bytes } = await exportRedacted({
      kind: "image",
      source,
      model: imageModel,
      redactions: [accepted({ type: "region", page: 1, boundingBox: IMAGE_BAND })],
      options: OPTIONS,
      mimeType: "image/png",
    })

    expect(Buffer.from(bytes).equals(Buffer.from(source))).toBe(false)
  })

  it("strips EXIF and GPS from the export", async () => {
    const source = await makeExifImageFixture()
    const { bytes } = await exportRedacted({
      kind: "image",
      source,
      model: {
        documentId: "doc_1",
        kind: "image",
        pages: [{ number: 1, width: 200, height: 200, text: "", spans: [] }],
      },
      redactions: [
        accepted({
          type: "region",
          page: 1,
          boundingBox: { x: 10, y: 10, width: 50, height: 50 },
        }),
      ],
      options: OPTIONS,
      mimeType: "image/jpeg",
    })

    expect((await sharp(Buffer.from(bytes)).metadata()).exif).toBeUndefined()
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("Test Author")
  })
})

describe("verification gate", () => {
  it("reports a leak when an accepted value survives", async () => {
    const source = await makeDocxFixture()
    // Verify the *unmodified* source against a redaction that claims the value
    // was removed: this is the check that must fail.
    const report = await verifyExport("docx", source, [
      accepted({ text: SENSITIVE.email, category: "email" }),
    ])

    expect(report.passed).toBe(false)
    expect(report.leaked).toContain(SENSITIVE.email)
  })

  it("passes when nothing was accepted", async () => {
    const source = await makeDocxFixture()
    const report = await verifyExport("docx", source, [])

    expect(report.passed).toBe(true)
    expect(report.checkedValues).toBe(0)
  })

  it("ignores values too short to assert on", async () => {
    const source = await makeDocxFixture()
    const report = await verifyExport("docx", source, [
      accepted({ text: "at", category: "other" }),
    ])

    expect(report.passed).toBe(true)
  })
})
