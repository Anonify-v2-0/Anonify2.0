import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import {
  artifactName,
  buildArchive,
  buildBatchReport,
  reportName,
  serializeBatchReport,
  uniqueNames,
  vaultName,
} from "@/lib/redaction/archive"
import {
  applyDocumentState,
  batchMethodFor,
  settleUnreached,
  toView,
  type BatchExportDocument,
  type BatchExportOptions,
} from "@/lib/documents/batch-exports"
import { buildSurrogates } from "@/lib/redaction/surrogates"
import { groupByBatch } from "@/lib/documents/grouping"
import type { DocumentListItem } from "@/lib/documents/listing"
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

function reportFor(
  documentId: string,
  redactions: Redaction[],
  method?: Redaction["method"]
): ExportReport {
  const withMethod = method
    ? redactions.map((redaction) => ({ ...redaction, method }))
    : redactions

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
    surrogates: buildSurrogates(withMethod, "pdf"),
    redactions: withMethod,
    verification: { passed: true, checkedValues: withMethod.length },
    generatedAt: new Date("2026-01-01T00:00:00.000Z"),
  })
}

const BASE_OPTIONS: BatchExportOptions = {
  addLabels: false,
  sanitizeMetadata: true,
  imageStyle: "solid",
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

/**
 * The session list, grouped. The order is the point: the list runs newest
 * first, a batch is reviewed oldest first, and both have to hold at once.
 */
describe("batch grouping", () => {
  function listed(
    id: string,
    batchId: string | null,
    createdAt: string
  ): DocumentListItem {
    return {
      id,
      originalName: `${id}.pdf`,
      kind: "pdf",
      mimeType: "application/pdf",
      size: 1024,
      status: "ready",
      pageCount: 1,
      createdAt,
      expiresAt: "2026-01-02T00:00:00.000Z",
      error: null,
      errorCode: null,
      hasExport: false,
      batchId,
      counts: { total: 0, suggested: 0, accepted: 0 },
    }
  }

  // Newest first, which is the order the documents page reads them in.
  const documents = [
    listed("solo_2", null, "2026-01-01T05:00:00.000Z"),
    listed("b_3", "bat_1", "2026-01-01T04:00:00.000Z"),
    listed("b_2", "bat_1", "2026-01-01T03:00:00.000Z"),
    listed("b_1", "bat_1", "2026-01-01T02:00:00.000Z"),
    listed("solo_1", null, "2026-01-01T01:00:00.000Z"),
  ]

  it("puts the batch where its newest document was, and orders it oldest first", () => {
    const entries = groupByBatch(documents)

    expect(entries.map((entry) => entry.kind)).toEqual([
      "document",
      "batch",
      "document",
    ])

    const batch = entries[1]
    if (batch.kind !== "batch") throw new Error("expected a batch entry")
    expect(batch.batchId).toBe("bat_1")
    // The order the batch page numbers them in, and the workspace steps
    // through them: "3 of 3" has to mean the same thing on every page.
    expect(batch.documents.map((document) => document.id)).toEqual([
      "b_1",
      "b_2",
      "b_3",
    ])
  })

  it("leaves a batch of one as a plain document", () => {
    const entries = groupByBatch([
      listed("only", "bat_2", "2026-01-01T00:00:00.000Z"),
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("document")
  })

  it("keeps two batches apart", () => {
    const entries = groupByBatch([
      listed("a_2", "bat_a", "2026-01-01T04:00:00.000Z"),
      listed("b_2", "bat_b", "2026-01-01T03:00:00.000Z"),
      listed("a_1", "bat_a", "2026-01-01T02:00:00.000Z"),
      listed("b_1", "bat_b", "2026-01-01T01:00:00.000Z"),
    ])

    expect(
      entries.map((entry) => (entry.kind === "batch" ? entry.batchId : "—"))
    ).toEqual(["bat_a", "bat_b"])
  })
})

/**
 * The durable export's own bookkeeping.
 *
 * A batch export outlives the request that asked for it, so its progress is a
 * row rather than a stream — and every step that writes to that row is retried,
 * which means the totals have to be a function of the states rather than a
 * counter something incremented twice.
 */
describe("batch export progress", () => {
  function planned(...ids: string[]): BatchExportDocument[] {
    return ids.map((id) => ({ id, name: `${id}.pdf`, state: "pending" }))
  }

  it("counts from the states, so a retried step cannot double-count", () => {
    let progress = applyDocumentState(planned("a", "b", "c"), "a", {
      state: "exported",
      removed: 3,
    })
    expect(progress.completed).toBe(1)
    expect(progress.exported).toBe(1)

    // The same step, run again after a retry.
    progress = applyDocumentState(progress.documents, "a", {
      state: "exported",
      removed: 3,
    })
    expect(progress.completed).toBe(1)
    expect(progress.exported).toBe(1)
  })

  it("counts a skipped document as settled but not as exported", () => {
    const progress = applyDocumentState(planned("a", "b"), "a", {
      state: "skipped",
      reason: "verification-failed",
    })

    expect(progress.completed).toBe(1)
    expect(progress.exported).toBe(0)
    expect(progress.documents[0].reason).toBe("verification-failed")
  })

  it("names every document a stopped run never reached", () => {
    const started = applyDocumentState(planned("a", "b", "c", "d"), "a", {
      state: "exported",
      removed: 1,
    })
    const during = applyDocumentState(started.documents, "b", {
      state: "exporting",
    })

    const settled = settleUnreached(during.documents, "cancelled")

    // Nothing is left looking like it is still being worked on, and the one
    // document that finished before the stop keeps its result.
    expect(settled.documents.map((document) => document.state)).toEqual([
      "exported",
      "skipped",
      "skipped",
      "skipped",
    ])
    expect(settled.exported).toBe(1)
    expect(settled.completed).toBe(4)
    expect(
      settled.documents
        .slice(1)
        .every((document) => document.reason === "cancelled")
    ).toBe(true)
  })

  it("hands the browser no download link until there is an archive", () => {
    const record = {
      id: "bex_1",
      batchId: "bat_1",
      workflowRunId: "run_1",
      status: "running",
      total: 3,
      completed: 1,
      exported: 1,
      documents: planned("a", "b", "c") as unknown as null,
      cancelRequested: false,
      error: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    }

    expect(toView(record).downloadUrl).toBeNull()
    expect(
      toView(record, "/api/batches/bat_1/download?token=x").downloadUrl
    ).toBe("/api/batches/bat_1/download?token=x")
  })
})

/**
 * A batch produces one artifact per document, and the reviewer chooses what
 * that one artifact does to the values — per file.
 *
 * Not one artifact per document per variant. Every variant is a full pass over
 * the document, so four of them across a dozen files is forty-eight exports,
 * and the archive would then hold four entries per document that nothing in
 * their names could tell apart. A reviewer who wants a second form of one file
 * exports that file on its own, where variants do exist.
 */
describe("a method per file in a batch", () => {
  it("falls back to masking for a file nobody decided about", () => {
    expect(batchMethodFor(BASE_OPTIONS, "doc_1")).toBe("mask")
  })

  it("applies the run's default to every file", () => {
    const options = { ...BASE_OPTIONS, method: "tokenize" as const }
    expect(batchMethodFor(options, "doc_1")).toBe("tokenize")
    expect(batchMethodFor(options, "doc_2")).toBe("tokenize")
  })

  it("lets one file differ from the rest of the run", () => {
    const options: BatchExportOptions = {
      ...BASE_OPTIONS,
      method: "mask",
      methodByDocument: { doc_2: "encrypt" },
    }

    expect(batchMethodFor(options, "doc_1")).toBe("mask")
    expect(batchMethodFor(options, "doc_2")).toBe("encrypt")
  })

  it("ignores a choice about a document this run never reaches", () => {
    // The dialog is a snapshot; a document can be deleted between opening it
    // and pressing the button. A stale id decides nothing.
    const options: BatchExportOptions = {
      ...BASE_OPTIONS,
      methodByDocument: { doc_gone: "tokenize" },
    }
    expect(batchMethodFor(options, "doc_1")).toBe("mask")
  })
})

describe("a batch report about files handled differently", () => {
  it("says how each document was treated rather than only how many", () => {
    const report = buildBatchReport({
      batchId: "bat_1",
      reports: [
        reportFor("doc_1", [accepted(SENSITIVE.person)], "mask"),
        reportFor("doc_2", [accepted("Jane Doe")], "tokenize"),
      ],
      skipped: [],
      vaulted: new Set(["doc_2"]),
    })

    // One document's counts say nothing about the next one's, which is exactly
    // the case a per-file batch creates.
    expect(report.documents).toEqual([
      expect.objectContaining({
        documentId: "doc_1",
        methods: { mask: 1 },
        vault: false,
      }),
      expect.objectContaining({
        documentId: "doc_2",
        methods: { tokenize: 1 },
        vault: true,
      }),
    ])
  })

  it("warns that a reversible file travels with what reverses it", () => {
    const report = buildBatchReport({
      batchId: "bat_1",
      reports: [reportFor("doc_1", [accepted(SENSITIVE.person)], "encrypt")],
      skipped: [],
      vaulted: new Set(["doc_1"]),
    })

    expect(report.notes.join(" ")).toContain("reversible by whoever holds the vault")
    expect(report.notes.join(" ")).toContain("Separate the vaults")
  })

  it("says a pseudonymized file is not reversible, and not anonymous either", () => {
    const report = buildBatchReport({
      batchId: "bat_1",
      reports: [
        reportFor("doc_1", [accepted(SENSITIVE.person)], "pseudonymize"),
      ],
      skipped: [],
    })

    const notes = report.notes.join(" ")
    expect(notes).toContain("Nothing reverses those")
    expect(notes).toContain("re-identify")
    expect(notes).not.toContain("reversible by whoever holds the vault")
  })

  it("quotes no value even when a document was tokenized", () => {
    // The vault carries the mapping; the batch report must not, and a
    // tokenized document is where that is easiest to get wrong.
    const serialized = Buffer.from(
      serializeBatchReport(
        buildBatchReport({
          batchId: "bat_1",
          reports: [
            reportFor("doc_1", [accepted(SENSITIVE.person)], "tokenize"),
          ],
          skipped: [],
          vaulted: new Set(["doc_1"]),
        })
      )
    ).toString("utf8")

    expect(serialized).not.toContain(SENSITIVE.person)
  })

  it("names a vault after the file it opens, and cannot escape the archive", () => {
    expect(vaultName("contract.pdf")).toBe("contract-vault.json")

    for (const hostile of ["../../etc/passwd.pdf", "/absolute/report.pdf"]) {
      const name = vaultName(hostile)
      expect(name).not.toMatch(/[\\/]/)
      expect(name.startsWith(".")).toBe(false)
    }
  })
})
