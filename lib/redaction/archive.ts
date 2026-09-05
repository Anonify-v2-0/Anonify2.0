import { zipSync } from "fflate"

import {
  REPORT_VERSION,
  type ExportReport,
  type RemovalStyle,
  type StyleCounts,
} from "@/lib/redaction/report"

/**
 * The batch archive.
 *
 * One export per document, delivered as a single file, because a reviewer who
 * uploaded eight documents wants eight results and not eight downloads. Each
 * document keeps its own artifact and its own report — nothing is merged, and
 * nothing about one document's redactions is inferable from another's.
 */

export type ArchiveFile = { name: string; bytes: Uint8Array }

/**
 * Two files in a batch can perfectly well be called `invoice.pdf`, and a zip
 * with the same entry twice loses one of them silently. Suffixed rather than
 * renamed wholesale, so the name the user recognises survives.
 */
export function uniqueNames(files: ArchiveFile[]): ArchiveFile[] {
  const taken = new Set<string>()

  return files.map((file) => {
    if (!taken.has(file.name)) {
      taken.add(file.name)
      return file
    }

    const dot = file.name.lastIndexOf(".")
    const base = dot === -1 ? file.name : file.name.slice(0, dot)
    const extension = dot === -1 ? "" : file.name.slice(dot)

    let counter = 2
    let candidate = `${base}-${counter}${extension}`
    while (taken.has(candidate)) {
      counter += 1
      candidate = `${base}-${counter}${extension}`
    }

    taken.add(candidate)
    return { name: candidate, bytes: file.bytes }
  })
}

export function buildArchive(files: ArchiveFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const file of uniqueNames(files)) {
    entries[file.name] = file.bytes
  }
  // Level 6 for the same reason the OOXML writer uses it: the inputs are mostly
  // already-compressed document formats, so a higher setting buys almost
  // nothing and costs real time on a large batch.
  return zipSync(entries, { level: 6 })
}

/** Why a document in the batch is not in the archive. */
export type SkipReason =
  | "not-ready"
  | "verification-failed"
  | "rate-limited"
  | "archive-full"
  | "export-failed"
  /** The reviewer stopped the run before this document was reached. */
  | "cancelled"

export type BatchReport = {
  version: number
  generatedAt: string
  batchId: string
  documents: {
    documentId: string
    sourceChecksum: string
    artifactChecksum: string
    removed: number
  }[]
  /**
   * Documents that are not in the archive, and why. A batch report that lists
   * only what worked would let a document quietly go missing, which is the one
   * failure mode a bundle of redacted files must not have.
   */
  skipped: { documentId: string; reason: SkipReason }[]
  totals: {
    documentsIncluded: number
    removed: number
    byCategory: { category: string; count: number }[]
    byStyle: StyleCounts
    notRemoved: number
  }
  notes: string[]
}

const SKIP_SENTENCES: Record<SkipReason, string> = {
  "not-ready": "had not finished processing",
  cancelled: "was not reached before the export was stopped",
  "verification-failed": "failed its export verification and was withheld",
  "rate-limited": "was not exported because the export allowance ran out",
  "archive-full": "did not fit in this archive",
  "export-failed": "could not be exported",
}

export function buildBatchReport(input: {
  batchId: string
  reports: ExportReport[]
  skipped: { documentId: string; reason: SkipReason }[]
  generatedAt?: Date
}): BatchReport {
  const byCategory = new Map<string, number>()
  const byStyle: StyleCounts = {}
  let removed = 0
  let notRemoved = 0

  for (const report of input.reports) {
    removed += report.removed.total
    notRemoved +=
      report.notRemoved.rejected.total + report.notRemoved.undecided.total

    for (const entry of report.removed.byCategory) {
      byCategory.set(
        entry.category,
        (byCategory.get(entry.category) ?? 0) + entry.count
      )
    }
    for (const [style, count] of Object.entries(report.removed.byStyle)) {
      const key = style as RemovalStyle
      byStyle[key] = (byStyle[key] ?? 0) + (count ?? 0)
    }
  }

  const notes = [
    "Counts only. Neither this report nor the per-document reports contain the redacted values.",
    "Each document was verified against its own exported bytes. A document that failed verification is listed as skipped rather than included.",
  ]

  for (const skip of input.skipped) {
    notes.push(`One document ${SKIP_SENTENCES[skip.reason]}.`)
  }

  return {
    version: REPORT_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    batchId: input.batchId,
    // Named by id and checksum rather than by filename, for the reason given in
    // lib/redaction/report.ts: a file is regularly named after the person it is
    // about. The per-document report inside the archive carries the same id.
    documents: input.reports.map((report) => ({
      documentId: report.document.id,
      sourceChecksum: report.document.sourceChecksum,
      artifactChecksum: report.artifact.checksum,
      removed: report.removed.total,
    })),
    skipped: input.skipped,
    totals: {
      documentsIncluded: input.reports.length,
      removed,
      byCategory: [...byCategory]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      byStyle,
      notRemoved,
    },
    notes,
  }
}

export function serializeBatchReport(report: BatchReport): Uint8Array {
  return new Uint8Array(
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8")
  )
}

/** `contract.pdf` → `contract-redacted.pdf`, keeping the name recognisable. */
export function artifactName(
  originalName: string,
  extension: string
): string {
  const base = originalName.replace(/\.[^.]+$/, "") || "document"
  return `${safeName(base)}-redacted.${extension}`
}

export function reportName(originalName: string): string {
  const base = originalName.replace(/\.[^.]+$/, "") || "document"
  return `${safeName(base)}-redaction-report.json`
}

/**
 * Zip entry names are paths. A file called `../../etc/passwd.pdf` is a name a
 * user can choose, and some extractors will happily honour it.
 */
function safeName(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 80)
      .trim() || "document"
  )
}
