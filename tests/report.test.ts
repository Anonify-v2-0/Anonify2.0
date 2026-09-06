import { describe, expect, it } from "vitest"

import {
  assertReportOmitsValues,
  buildExportReport,
  ReportLeakError,
  serializeExportReport,
  type ExportReport,
} from "@/lib/redaction/report"
import type { DocumentKind } from "@/types/document"
import type { Redaction, RedactionStatus } from "@/types/redaction"
import { SENSITIVE } from "./fixtures"

/**
 * The report is an artifact handed to someone who was not shown the original,
 * so these read the produced bytes rather than the intent: what the counts say,
 * and — the one that matters — that the values themselves are not in there.
 */

let counter = 0

function redaction(input: Partial<Redaction> = {}): Redaction {
  counter += 1
  return {
    id: `red_${counter}`,
    documentId: "doc_1",
    type: "text",
    source: "ai",
    category: "other",
    status: "accepted",
    ...input,
  }
}

function report(
  redactions: Redaction[],
  kind: DocumentKind = "pdf",
  imageStyle: "solid" | "blur" | "pixelate" = "solid"
): ExportReport {
  return buildExportReport({
    document: {
      id: "doc_1",
      kind,
      sizeBytes: 4096,
      pageCount: 2,
      sourceChecksum: "a".repeat(64),
    },
    artifact: {
      checksum: "b".repeat(64),
      sizeBytes: 3072,
      mimeType: "application/pdf",
      extension: "pdf",
    },
    options: { addLabels: false, sanitizeMetadata: true, imageStyle },
    redactions,
    verification: { passed: true, checkedValues: 3 },
    generatedAt: new Date("2026-01-01T00:00:00.000Z"),
  })
}

describe("export report", () => {
  it("counts what was removed by category, source and style", () => {
    const built = report([
      redaction({ category: "email", text: SENSITIVE.email }),
      redaction({ category: "email", text: "second@example.com" }),
      redaction({ category: "person", text: SENSITIVE.person, source: "user" }),
      redaction({ category: "person", status: "rejected", text: "Jane Doe" }),
    ])

    expect(built.removed.total).toBe(3)
    expect(built.removed.byCategory).toEqual([
      { category: "email", count: 2, styles: { removed: 2 }, methods: { mask: 2 } },
      { category: "person", count: 1, styles: { removed: 1 }, methods: { mask: 1 } },
    ])
    expect(built.removed.byMethod).toEqual({ mask: 3 })
    expect(built.removed.bySource).toEqual({ ai: 2, user: 1, rule: 0 })
    expect(built.removed.byStyle).toEqual({ removed: 3 })
  })

  it("separates what the reviewer rejected from what they never decided", () => {
    const built = report([
      redaction({ category: "email", text: SENSITIVE.email }),
      redaction({ category: "phone", status: "rejected", text: SENSITIVE.phone }),
      redaction({ category: "phone", status: "suggested", text: "+1 555 0000" }),
      redaction({ category: "person", status: "suggested", text: "Jane Doe" }),
    ])

    expect(built.notRemoved.rejected).toEqual({
      total: 1,
      byCategory: [{ category: "phone", count: 1 }],
    })
    expect(built.notRemoved.undecided.total).toBe(2)
    expect(built.notes.join(" ")).toContain("remain in the exported file")
  })

  it("records the weaker image styles rather than calling everything removal", () => {
    const built = report(
      [
        redaction({
          category: "face",
          type: "face",
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
        }),
        redaction({
          category: "person",
          type: "region",
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
        }),
      ],
      "image",
      "blur"
    )

    // Only a face takes the chosen style; everything else is solid. The report
    // has to agree with lib/redaction/apply.ts, not with the dialog's default.
    expect(built.removed.byStyle).toEqual({ blur: 1, solid: 1 })
    expect(built.notes.join(" ")).toContain("weaker guarantee")
  })

  it("does not name an unrecognised category the analysis invented", () => {
    const built = report([
      redaction({ category: "employee-nickname-Jonno", text: "Jonno" }),
    ])

    expect(built.removed.byCategory).toEqual([
      { category: "other", count: 1, styles: { removed: 1 }, methods: { mask: 1 } },
    ])
  })

  it("carries none of the values it accounts for", () => {
    const redactions = Object.values(SENSITIVE).map((text, index) =>
      redaction({
        text,
        category: "person",
        reason: `looks like a ${text}`,
        status: (index === 0 ? "rejected" : "accepted") as RedactionStatus,
      })
    )

    const serialized = Buffer.from(
      serializeExportReport(report(redactions))
    ).toString("utf8")

    for (const value of Object.values(SENSITIVE)) {
      expect(serialized).not.toContain(value)
    }
    // Nor a rejected one: what a reviewer declined is still document content.
    expect(serialized).not.toContain("looks like")
  })

  it("refuses a report that gained a field carrying a redacted value", () => {
    const accepted = [redaction({ text: SENSITIVE.person, category: "person" })]
    const built = report(accepted)

    // What a future "just one example value" change would look like.
    const leaking = {
      ...built,
      removed: {
        ...built.removed,
        byCategory: built.removed.byCategory.map((entry) => ({
          ...entry,
          sample: SENSITIVE.person,
        })),
      },
    } as unknown as ExportReport

    expect(() => assertReportOmitsValues(built, accepted)).not.toThrow()
    expect(() => assertReportOmitsValues(leaking, accepted)).toThrow(
      ReportLeakError
    )
  })

  it("does not trip over a value that collides with its own prose", () => {
    // "port" is inside "report", and a four-letter cell value is ordinary.
    const accepted = [redaction({ text: "port", category: "other" })]
    expect(() => assertReportOmitsValues(report(accepted), accepted)).not.toThrow()
  })

  it("ties the pair together with both checksums", () => {
    const built = report([redaction({ text: SENSITIVE.email })])

    expect(built.document.sourceChecksum).toBe("a".repeat(64))
    expect(built.artifact.checksum).toBe("b".repeat(64))
    expect(built.artifact.metadataSanitized).toBe(true)
    expect(built).not.toHaveProperty("document.name")
  })
})

describe("what the report says about a message's attachments", () => {
  const attachments = [
    {
      partPath: "0.2",
      disposition: "redacted" as const,
      kind: "pdf" as DocumentKind,
      inline: false,
      childDocumentId: "doc_child",
      artifactChecksum: "c".repeat(64),
      reason: null,
    },
    {
      partPath: "0.3",
      disposition: "carried-through" as const,
      kind: null,
      inline: false,
      childDocumentId: null,
      artifactChecksum: null,
      reason: "it is not in a format Anonify can read",
    },
    {
      partPath: "0.4",
      disposition: "removed" as const,
      kind: "docx" as DocumentKind,
      inline: true,
      childDocumentId: "doc_other",
      artifactChecksum: null,
      reason: "it had not finished processing",
    },
  ]

  // Cloned, so a test that mutates an entry to prove the leak check works
  // cannot leave that entry mutated for the next one.
  function messageReport(extra: typeof attachments = attachments): ExportReport {
    const entries = extra.map((entry) => ({ ...entry }))
    return buildExportReport({
      document: {
        id: "doc_1",
        kind: "eml",
        sizeBytes: 8192,
        pageCount: 1,
        sourceChecksum: "a".repeat(64),
      },
      artifact: {
        checksum: "b".repeat(64),
        sizeBytes: 7000,
        mimeType: "message/rfc822",
        extension: "eml",
      },
      options: { addLabels: false, sanitizeMetadata: true },
      redactions: [redaction({ text: SENSITIVE.person })],
      verification: { passed: true, checkedValues: 1 },
      attachments: entries,
      generatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
  }

  it("names every attachment by part path and disposition", () => {
    const built = messageReport()

    expect(built.attachments).toHaveLength(3)
    expect(built.attachments?.map((entry) => entry.partPath)).toEqual([
      "0.2",
      "0.3",
      "0.4",
    ])
    // Never a filename: a file is regularly named after the person it is about.
    expect(JSON.stringify(built.attachments)).not.toContain(".pdf")
  })

  it("says out loud that a carried-through attachment was not redacted", () => {
    const notes = messageReport().notes.join("\n")

    expect(notes).toMatch(/carried through unchanged/)
    expect(notes).toMatch(/Nothing inside it was redacted/)
    expect(notes).toMatch(/removed rather than carried through/)
    expect(notes).toMatch(/verified separately/)
  })

  it("omits the section entirely for a document with no attachments", () => {
    expect(report([redaction()]).attachments).toBeUndefined()
    expect(messageReport([]).attachments).toBeUndefined()
  })

  it("does not trip the leak check on part paths, ids or checksums", () => {
    expect(() =>
      assertReportOmitsValues(messageReport(), [
        redaction({ text: SENSITIVE.person }),
      ])
    ).not.toThrow()
  })

  it("fails the export if a later change puts a value in an attachment entry", () => {
    const built = messageReport()
    // A field added later that carries a filename, which is where an
    // attachment's most identifying string actually lives.
    ;(built.attachments![0] as unknown as Record<string, string>).filename =
      `${SENSITIVE.person}.pdf`

    expect(() =>
      assertReportOmitsValues(built, [redaction({ text: SENSITIVE.person })])
    ).toThrow(ReportLeakError)
  })

  it("still refuses a value that reaches the reason it wrote", () => {
    const built = messageReport()
    expect(built.attachments?.[2].reason).not.toContain(SENSITIVE.person)

    const leaked = serializeExportReport(built)
    expect(Buffer.from(leaked).toString("utf8")).not.toContain(SENSITIVE.person)
  })
})
