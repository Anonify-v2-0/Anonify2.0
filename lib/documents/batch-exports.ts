import type { Prisma } from "@/lib/database/generated/client"
import { prisma } from "@/lib/database/prisma"
import type { SkipReason } from "@/lib/redaction/archive"

/**
 * The state of a batch export, as a record rather than a response.
 *
 * A batch export is minutes of work: a dozen documents, each redacted,
 * verified and sealed on its own. That outlives the request that asked for it
 * — on a serverless host the function that started it will be recycled long
 * before the work is done — so the progress cannot live in a response stream
 * that dies with the connection.
 *
 * It lives here instead. The durable run writes to this row as it goes, and
 * anything that wants to know — the modal, the button behind it, a second tab,
 * the same person an hour later on another device — reads the row.
 */

export type BatchExportStatus =
  "queued" | "running" | "ready" | "failed" | "cancelled"

export type BatchExportDocumentState =
  "pending" | "exporting" | "exported" | "skipped"

export type BatchExportDocument = {
  id: string
  /** The filename, which the reviewer already knows. Nothing from inside it. */
  name: string
  state: BatchExportDocumentState
  /** Redactions applied, once it is exported. */
  removed?: number
  /** Why it is not in the archive. */
  reason?: SkipReason
}

/** What the browser is given. `downloadUrl` is minted per read, never stored. */
export type BatchExportView = {
  id: string
  batchId: string
  status: BatchExportStatus
  total: number
  completed: number
  exported: number
  documents: BatchExportDocument[]
  cancelRequested: boolean
  error: string | null
  createdAt: string
  updatedAt: string
  /** Present only when there is an archive to fetch, and short-lived. */
  downloadUrl: string | null
}

export type BatchExportOptions = {
  addLabels: boolean
  sanitizeMetadata: boolean
  imageStyle: "solid" | "blur" | "pixelate"
}

/** A run that has not finished, and so must not be started a second time. */
export const ACTIVE_STATUSES: BatchExportStatus[] = ["queued", "running"]

export type BatchExportRecord = {
  id: string
  batchId: string
  workflowRunId: string | null
  status: string
  total: number
  completed: number
  exported: number
  documents: Prisma.JsonValue | null
  cancelRequested: boolean
  error: string | null
  createdAt: Date
  updatedAt: Date
}

export const BATCH_EXPORT_SELECT = {
  id: true,
  batchId: true,
  workflowRunId: true,
  status: true,
  total: true,
  completed: true,
  exported: true,
  documents: true,
  cancelRequested: true,
  error: true,
  createdAt: true,
  updatedAt: true,
} as const

export function readDocuments(
  value: Prisma.JsonValue | null
): BatchExportDocument[] {
  return Array.isArray(value) ? (value as unknown as BatchExportDocument[]) : []
}

export function toView(
  record: BatchExportRecord,
  downloadUrl: string | null = null
): BatchExportView {
  return {
    id: record.id,
    batchId: record.batchId,
    status: record.status as BatchExportStatus,
    total: record.total,
    completed: record.completed,
    exported: record.exported,
    documents: readDocuments(record.documents),
    cancelRequested: record.cancelRequested,
    error: record.error,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    downloadUrl,
  }
}

/** The batch's most recent export, whatever state it is in. */
export async function latestBatchExport(
  batchId: string
): Promise<BatchExportRecord | null> {
  return prisma.batchExport.findFirst({
    where: { batchId },
    orderBy: { createdAt: "desc" },
    select: BATCH_EXPORT_SELECT,
  })
}

export async function activeBatchExport(
  batchId: string
): Promise<BatchExportRecord | null> {
  return prisma.batchExport.findFirst({
    where: { batchId, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: BATCH_EXPORT_SELECT,
  })
}

/** A document nobody has reached a verdict on yet. */
export function isUnreached(document: BatchExportDocument): boolean {
  return document.state === "pending" || document.state === "exporting"
}

export type BatchExportProgress = {
  documents: BatchExportDocument[]
  completed: number
  exported: number
}

/**
 * One document's outcome, and what it makes the totals.
 *
 * Counted from the list rather than incremented, so a step that runs twice —
 * which is what a retried step is — cannot double-count the document it is
 * retrying. The totals are a function of the states, and the states are
 * idempotent.
 */
export function applyDocumentState(
  documents: BatchExportDocument[],
  documentId: string,
  next: Omit<BatchExportDocument, "id" | "name">
): BatchExportProgress {
  const updated = documents.map((document) =>
    document.id === documentId ? { ...document, ...next } : document
  )

  return {
    documents: updated,
    completed: updated.filter(
      (document) =>
        document.state === "exported" || document.state === "skipped"
    ).length,
    exported: updated.filter((document) => document.state === "exported")
      .length,
  }
}

/**
 * Every document the run never reached, named with one reason.
 *
 * A row that leaves them "pending" reads as a run that is still working, which
 * is the one thing a stopped run must not look like.
 */
export function settleUnreached(
  documents: BatchExportDocument[],
  reason: SkipReason
): BatchExportProgress {
  let progress: BatchExportProgress = {
    documents,
    completed: documents.filter((document) => !isUnreached(document)).length,
    exported: documents.filter((document) => document.state === "exported")
      .length,
  }

  for (const document of documents.filter(isUnreached)) {
    progress = applyDocumentState(progress.documents, document.id, {
      state: "skipped",
      reason,
    })
  }

  return progress
}

async function writeProgress(
  exportId: string,
  progress: BatchExportProgress
): Promise<void> {
  await prisma.batchExport.update({
    where: { id: exportId },
    data: {
      documents: progress.documents as unknown as Prisma.InputJsonValue,
      completed: progress.completed,
      exported: progress.exported,
    },
  })
}

/**
 * Records one document's outcome.
 *
 * The whole list is rewritten rather than patched in place: the steps that call
 * this run one at a time — a batch export is deliberately sequential, so each
 * document is charged the export allowance it would have been charged on its
 * own — so there is no concurrent writer to lose an update to.
 */
export async function patchDocumentState(
  exportId: string,
  documentId: string,
  next: Omit<BatchExportDocument, "id" | "name">
): Promise<void> {
  const record = await prisma.batchExport.findUnique({
    where: { id: exportId },
    select: { documents: true },
  })
  if (!record) return

  await writeProgress(
    exportId,
    applyDocumentState(readDocuments(record.documents), documentId, next)
  )
}

/** Names every document the run never reached, in one write. */
export async function settlePending(
  exportId: string,
  reason: SkipReason
): Promise<void> {
  const record = await prisma.batchExport.findUnique({
    where: { id: exportId },
    select: { documents: true },
  })
  if (!record) return

  await writeProgress(
    exportId,
    settleUnreached(readDocuments(record.documents), reason)
  )
}
