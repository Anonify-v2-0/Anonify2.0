import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import {
  artifactName,
  buildArchive,
  buildBatchReport,
  reportName,
  serializeBatchReport,
  uniqueNames,
} from "@/lib/redaction/archive"
import { buildExportReport, type ExportReport } from "@/lib/redaction/report"
import type { Redaction } from "@/types/redaction"
import { SENSITIVE } from "./fixtures"

/**
 * The batch archive, read back out of the zip rather than asserted on the
 * intent — the same way the export suites read the artifact they produced.
 */

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "utf8"))
}

let counter = 0

function accepted(text: string, category = "person"): Redaction {
  counter += 1
  return {
    id: `red_${counter}`,
    documentId: "doc_1",
    type: "text",
    source: "ai",
    category,
    status: "accepted",
    text,
  }
}

function reportFor(documentId: string, redactions: Redaction[]): ExportReport {
  return buildExportReport({
    document: {
      id: documentId,
      kind: "pdf",
      sizeBytes: 2048,
      pageCount: 1,
      sourceChecksum: `${documentId}-source`,
    },
    artifact: {
      checksum: `${documentId}-artifact`,
      sizeBytes: 1024,
      mimeType: "application/pdf",
      extension: "pdf",
    },
    options: { addLabels: false, sanitizeMetadata: true },
    redactions,
    verification: { passed: true, checkedValues: redactions.length },
    generatedAt: new Date("2026-01-01T00:00:00.000Z"),
  })
}

describe("batch archive", () => {
  it("keeps both files when two documents share a name", () => {
    const named = uniqueNames([
      { name: "invoice-redacted.pdf", bytes: bytes("a") },
      { name: "invoice-redacted.pdf", bytes: bytes("b") },
      { name: "invoice-redacted.pdf", bytes: bytes("c") },
    ])

    expect(named.map((file) => file.name)).toEqual([
      "invoice-redacted.pdf",
      "invoice-redacted-2.pdf",
      "invoice-redacted-3.pdf",
    ])
  })

  it("does not let a filename escape the archive directory", () => {
    // Zip entry names are paths, and some extractors honour a traversal in one.
    for (const hostile of [
      "../../etc/passwd.pdf",
      "/absolute/report.pdf",
      "..\\windows\\system32.pdf",
    ]) {
      for (const name of [artifactName(hostile, "pdf"), reportName(hostile)]) {
        expect(name).not.toMatch(/[\\/]/)
        expect(name.startsWith(".")).toBe(false)
      }
    }

    expect(artifactName("contract.pdf", "pdf")).toBe("contract-redacted.pdf")
    expect(reportName("contract.pdf")).toBe("contract-redaction-report.json")
  })

  it("builds a zip whose entries survive a round trip", () => {
    const archive = buildArchive([
      { name: "one-redacted.pdf", bytes: bytes("first") },
      { name: "one-redacted.pdf", bytes: bytes("second") },
      { name: "batch-report.json", bytes: bytes("{}") },
    ])

    const entries = unzipSync(archive)
    expect(Object.keys(entries).sort()).toEqual([
      "batch-report.json",
      "one-redacted-2.pdf",
      "one-redacted.pdf",
    ])
    expect(Buffer.from(entries["one-redacted-2.pdf"]).toString()).toBe("second")
  })
})

describe("batch report", () => {
  it("rolls the per-document counts up without merging the documents", () => {
    const report = buildBatchReport({
      batchId: "bat_1",
      reports: [
        reportFor("doc_1", [
          accepted(SENSITIVE.person),
          accepted(SENSITIVE.email, "email"),
        ]),
        reportFor("doc_2", [accepted("Jane Doe")]),
      ],
      skipped: [],
      generatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })

    expect(report.totals.documentsIncluded).toBe(2)
    expect(report.totals.removed).toBe(3)
    expect(report.totals.byCategory).toEqual([
      { category: "person", count: 2 },
      { category: "email", count: 1 },
    ])
    expect(report.documents.map((entry) => entry.documentId)).toEqual([
      "doc_1",
      "doc_2",
    ])
  })

  it("names the documents it could not include, and why", () => {
    const report = buildBatchReport({
      batchId: "bat_1",
      reports: [reportFor("doc_1", [accepted(SENSITIVE.person)])],
      skipped: [
        { documentId: "doc_2", reason: "verification-failed" },
        { documentId: "doc_3", reason: "not-ready" },
      ],
    })

    // A batch report that listed only what worked would let a document go
    // missing silently, which is the failure a bundle must not have.
    expect(report.skipped).toHaveLength(2)
    expect(report.notes.join(" ")).toContain("failed its export verification")
    expect(report.notes.join(" ")).toContain("had not finished processing")
  })

  it("quotes none of the values from any document in the batch", () => {
    const values = Object.values(SENSITIVE)
    const serialized = Buffer.from(
      serializeBatchReport(
        buildBatchReport({
          batchId: "bat_1",
          reports: [
            reportFor(
              "doc_1",
              values.map((value) => accepted(value))
            ),
          ],
          skipped: [],
        })
      )
    ).toString("utf8")

    for (const value of values) {
      expect(serialized).not.toContain(value)
    }
  })
})
