import type { OwnedBatch } from "@/lib/documents/batches"
import { listBatchDocuments } from "@/lib/documents/listing"
import type { ExportOptions } from "@/lib/redaction/apply"
import type { SkipReason } from "@/lib/redaction/archive"
import { exportAndStore } from "@/lib/redaction/deliver"
import { ExportVerificationError } from "@/lib/redaction/export"
import { ReportLeakError } from "@/lib/redaction/report"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { createBatchToken } from "@/lib/security/signed-url"

/**
 * Exporting every document in a batch, one event at a time.
 *
 * The work itself is what it always was — each document exported exactly as it
 * would be on its own, and a document that fails removed from the archive and
 * named rather than allowed to fail the batch. What is new is that the run
 * reports itself as it goes.
 *
 * A batch of a dozen documents is a minute of a spinner, and a spinner cannot
 * say which document it is on, that four are already done, or that the fifth
 * was withheld. The generator yields that; the route decides whether to stream
 * the events to the browser or collapse them into one JSON reply.
 */

export type BatchExportDocument = {
  id: string
  name: string
  status: string
}

export type BatchExportSkip = { documentId: string; reason: SkipReason }

export type BatchExportedDocument = {
  documentId: string
  artifactId: string
  removed: number
}

export type BatchExportEvent =
  /** The plan, sent before any work: what will be attempted, and in what order. */
  | { type: "start"; documents: BatchExportDocument[] }
  /** This document is being exported now. */
  | { type: "exporting"; documentId: string }
  | { type: "exported"; documentId: string; removed: number }
  | { type: "skipped"; documentId: string; reason: SkipReason }
  | {
      type: "done"
      exported: BatchExportedDocument[]
      skipped: BatchExportSkip[]
      /** Null when nothing was exported: there is no archive to fetch. */
      downloadUrl: string | null
    }

export type BatchExportResult = {
  exported: BatchExportedDocument[]
  skipped: BatchExportSkip[]
  downloadUrl: string | null
}

/** A batch whose documents have all expired between the click and the run. */
export class EmptyBatchError extends Error {}

export async function* runBatchExport(input: {
  batch: OwnedBatch
  options: ExportOptions
  networkKey: string
}): AsyncGenerator<BatchExportEvent> {
  const documents = await listBatchDocuments(input.batch.id)
  if (documents.length === 0) throw new EmptyBatchError()

  yield {
    type: "start",
    documents: documents.map((document) => ({
      id: document.id,
      name: document.originalName,
      status: document.status,
    })),
  }

  const exported: BatchExportedDocument[] = []
  const skipped: BatchExportSkip[] = []
  let allowanceGone = false

  for (const document of documents) {
    if (allowanceGone) {
      skipped.push({ documentId: document.id, reason: "rate-limited" })
      yield { type: "skipped", documentId: document.id, reason: "rate-limited" }
      continue
    }

    if (document.status !== "ready") {
      skipped.push({ documentId: document.id, reason: "not-ready" })
      yield { type: "skipped", documentId: document.id, reason: "not-ready" }
      continue
    }

    // Announced before the allowance is spent, so the row the reviewer is
    // watching turns over at the moment the work on it starts.
    yield { type: "exporting", documentId: document.id }

    const limit = await consumeRateLimit("export", input.networkKey)
    if (!limit.allowed) {
      allowanceGone = true
      skipped.push({ documentId: document.id, reason: "rate-limited" })
      yield { type: "skipped", documentId: document.id, reason: "rate-limited" }
      continue
    }

    try {
      const outcome = await exportAndStore(document.id, input.options)
      if (!outcome.ok) {
        skipped.push({ documentId: document.id, reason: "not-ready" })
        yield { type: "skipped", documentId: document.id, reason: "not-ready" }
        continue
      }

      exported.push({
        documentId: document.id,
        artifactId: outcome.delivered.artifactId,
        removed: outcome.delivered.appliedRedactions,
      })
      yield {
        type: "exported",
        documentId: document.id,
        removed: outcome.delivered.appliedRedactions,
      }
    } catch (error) {
      // One document's failure is one document's failure. It is logged with
      // its category, left out of the archive, and named in the response —
      // never delivered, and never allowed to cost the others their export.
      const reason: SkipReason =
        error instanceof ExportVerificationError ||
        error instanceof ReportLeakError
          ? "verification-failed"
          : "export-failed"

      console.error(
        JSON.stringify({
          level: "error",
          context: "batches.export",
          batchId: input.batch.id,
          documentId: document.id,
          errorCategory: reason,
        })
      )

      skipped.push({ documentId: document.id, reason })
      yield { type: "skipped", documentId: document.id, reason }
    }
  }

  yield {
    type: "done",
    exported,
    skipped,
    downloadUrl:
      exported.length === 0
        ? null
        : `/api/batches/${input.batch.id}/download?token=${createBatchToken({
            batchId: input.batch.id,
            ownerKey: input.batch.userFingerprint,
          })}`,
  }
}

/** The whole run, for callers that want one answer rather than a commentary. */
export async function collectBatchExport(input: {
  batch: OwnedBatch
  options: ExportOptions
  networkKey: string
}): Promise<BatchExportResult> {
  for await (const event of runBatchExport(input)) {
    if (event.type === "done") {
      return {
        exported: event.exported,
        skipped: event.skipped,
        downloadUrl: event.downloadUrl,
      }
    }
  }

  // Unreachable: the generator always ends with `done`.
  return { exported: [], skipped: [], downloadUrl: null }
}
