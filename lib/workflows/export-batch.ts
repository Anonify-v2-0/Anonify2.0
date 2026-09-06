import {
  FatalError,
  getStepMetadata,
  getWritable,
  RetryableError,
} from "workflow"

import type { Prisma } from "@/lib/database/generated/client"
import { prisma } from "@/lib/database/prisma"
import {
  patchDocumentState,
  readDocuments,
  settlePending,
  type BatchExportDocument,
  batchMethodFor,
  type BatchExportOptions,
  type BatchExportProgress,
  type BatchExportStatus,
} from "@/lib/documents/batch-exports"
import { exportConcurrency } from "@/lib/documents/batch-config"
import { listBatchDocuments } from "@/lib/documents/listing"
import type { SkipReason } from "@/lib/redaction/archive"
import { exportAndStore } from "@/lib/redaction/deliver"
import { categoriesAllowing } from "@/lib/redaction/methods"
import { defaultVariant } from "@/lib/redaction/variants"
import { ExportVerificationError } from "@/lib/redaction/export"
import { ReportLeakError } from "@/lib/redaction/report"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import {
  encodeBatchExportEvent,
  type BatchExportStreamEvent,
} from "@/lib/workflows/batch-export-events"

/**
 * Durable batch export.
 *
 * The work is what it always was — each document exported exactly as it would
 * be on its own, through the same builder and the same verification gate, with
 * a document that fails left out and named rather than allowed to fail the
 * batch. What changes is who is holding it.
 *
 * It used to be the request. Twelve documents is minutes of redaction, OCR-free
 * or not, and a serverless function has neither that long nor any memory of
 * what it was doing when it is recycled. So the reviewer's browser was the only
 * thing keeping the run alive, and closing the modal, losing the tab or a
 * platform timeout threw away every document that had already been exported.
 *
 * Here each document is its own step: retried on its own, its result persisted,
 * and the run resumed from the last one that finished rather than from the top.
 * The reviewer can close everything and come back to a finished archive.
 */

const MAX_BACKOFF_MS = 30_000

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempt - 1))
}

/** Same pacing as the processing pipeline; see lib/workflows/process-document.ts. */
function paced(error: unknown): never {
  if (FatalError.is(error)) throw error

  const message = error instanceof Error ? error.message : String(error)
  const { attempt } = getStepMetadata()

  throw new RetryableError(message, { retryAfter: backoffMs(attempt) })
}

/**
 * Says where the run has got to.
 *
 * The row is written first and this is written second, in that order on
 * purpose: the stream is a courtesy to whoever is watching right now, and the
 * record is what anyone else reads. A client that misses this — because it was
 * closed, or reconnecting — loses nothing but the animation.
 *
 * A whole snapshot each time, so a client that missed one event is corrected by
 * the next rather than drifting.
 */
async function report(
  progress: BatchExportProgress,
  status: BatchExportStatus,
  extra: { type?: BatchExportStreamEvent["type"]; error?: string | null } = {}
): Promise<void> {
  const event: BatchExportStreamEvent = {
    type: extra.type ?? "export.progress",
    at: new Date().toISOString(),
    status,
    total: progress.documents.length,
    completed: progress.completed,
    exported: progress.exported,
    documents: progress.documents,
    error: extra.error ?? null,
  }

  const writer = getWritable<string>().getWriter()
  try {
    await writer.write(encodeBatchExportEvent(event))
  } finally {
    // An unreleased lock keeps the step's request alive until it times out.
    writer.releaseLock()
  }
}

/**
 * The plan: which documents, in which order, recorded before any work.
 *
 * Written to the row so the modal has something to render on its first read —
 * and so a reader that arrives after the run has finished still sees the
 * documents it covered rather than a bare count.
 */
async function planExport(
  exportId: string
): Promise<{ documentIds: string[]; width: number }> {
  "use step"
  return runPlan(exportId).catch(paced)
}

async function runPlan(
  exportId: string
): Promise<{ documentIds: string[]; width: number }> {
  const record = await prisma.batchExport.findUnique({
    where: { id: exportId },
    select: { batchId: true, documents: true, status: true },
  })
  if (!record) throw new FatalError("This export no longer exists")

  // Replaying after a retry: the plan is already recorded, and re-listing could
  // pick up a different set if a document expired in between.
  const planned = readDocuments(record.documents)
  if (planned.length > 0) {
    await prisma.batchExport.update({
      where: { id: exportId },
      data: { status: "running" },
    })
    await report(progressOf(planned), "running")
    return {
      documentIds: planned.map((document) => document.id),
      width: exportConcurrency(),
    }
  }

  const documents = await listBatchDocuments(record.batchId)
  if (documents.length === 0) {
    throw new FatalError("This batch has no documents left")
  }

  const rows: BatchExportDocument[] = documents.map((document) => ({
    id: document.id,
    name: document.originalName,
    state: "pending",
  }))

  await prisma.batchExport.update({
    where: { id: exportId },
    data: {
      status: "running",
      total: rows.length,
      completed: 0,
      exported: 0,
      documents: rows as unknown as Prisma.InputJsonValue,
    },
  })

  await report(progressOf(rows), "running")

  // Read once, inside the step, and carried through the run. A workflow
  // function replays, so reading configuration there would let a value changed
  // mid-run reshape the waves on the replay and re-export documents that were
  // already done. It is also a plain environment read, which is not a thing a
  // workflow function may do.
  return { documentIds: rows.map((row) => row.id), width: exportConcurrency() }
}

/** The totals a list of documents already implies. */
function progressOf(documents: BatchExportDocument[]): BatchExportProgress {
  return {
    documents,
    completed: documents.filter(
      (document) =>
        document.state === "exported" || document.state === "skipped"
    ).length,
    exported: documents.filter((document) => document.state === "exported")
      .length,
  }
}

/**
 * One document, exported and recorded.
 *
 * Returns whether the run should stop. Everything else — a refused
 * verification, a document still processing, an exhausted allowance — removes
 * this one document from the archive and is named on the row, which is the rule
 * that makes a batch worth having: one document's failure is one document's.
 */
async function exportDocument(
  exportId: string,
  documentId: string
): Promise<StepOutcome> {
  "use step"
  return runExportDocument(exportId, documentId).catch(paced)
}

// Storage reads, a redaction pass and two writes back. A blip is weather, and
// losing it would mean redacting this document again from scratch.
exportDocument.maxRetries = 4

/** Continue, or stop with the reason everything after this one inherits. */
type StepOutcome = { stop: false } | { stop: true; reason: SkipReason }

/** Writes one document's outcome, then says so on the run's stream. */
async function patched(
  exportId: string,
  documentId: string,
  next: Omit<BatchExportDocument, "id" | "name">
): Promise<void> {
  const progress = await patchDocumentState(exportId, documentId, next)
  if (progress) await report(progress, "running")
}

async function runExportDocument(
  exportId: string,
  documentId: string
): Promise<StepOutcome> {
  const record = await prisma.batchExport.findUnique({
    where: { id: exportId },
    select: {
      status: true,
      cancelRequested: true,
      options: true,
      networkKey: true,
      documents: true,
    },
  })
  if (!record) throw new FatalError("This export no longer exists")

  // Asked to stop, or stopped already. Checked here rather than in the
  // orchestrator because the orchestrator replays: a cancel has to be read at
  // the moment the next document would start, not at the moment the loop was
  // first written.
  if (record.cancelRequested || record.status === "cancelled") {
    return { stop: true, reason: "cancelled" }
  }

  // Replaying after a retry that already got this far.
  const current = readDocuments(record.documents).find(
    (document) => document.id === documentId
  )
  if (
    current &&
    (current.state === "exported" || current.state === "skipped")
  ) {
    return { stop: false }
  }

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { status: true, expiresAt: true },
  })

  const skip = async (reason: SkipReason): Promise<StepOutcome> => {
    await patched(exportId, documentId, { state: "skipped", reason })
    return { stop: false }
  }

  // Gone or expired between the plan and now: not ready, and never will be.
  if (!document || document.expiresAt.getTime() <= Date.now()) {
    return skip("not-ready")
  }
  if (document.status !== "ready") return skip("not-ready")

  await patched(exportId, documentId, { state: "exporting" })

  // Charged per document, because that is what the work is. A batch is not a
  // discount, and pricing it as one would make the limit meaningless to anyone
  // willing to drag more files in at once.
  const limit = await consumeRateLimit(
    "export",
    record.networkKey ?? "anonymous"
  )
  if (!limit.allowed) {
    // The allowance is gone for everything that follows too, so the run stops
    // here and the rest are named as rate-limited rather than each spending a
    // step to discover the same thing.
    await patched(exportId, documentId, {
      state: "skipped",
      reason: "rate-limited",
    })
    return { stop: true, reason: "rate-limited" }
  }

  const options = (record.options ?? {}) as BatchExportOptions

  try {
    // One variant, chosen for this file. The reviewer picked it per document,
    // and the categories it reaches are decided by what is defensible for each
    // rather than by the pick — asking for a tokenized government id still
    // produces a mask, here as everywhere.
    const method = batchMethodFor(options, documentId)

    const outcome = await exportAndStore(
      documentId,
      [
        defaultVariant({
          addLabels: options.addLabels ?? false,
          sanitizeMetadata: options.sanitizeMetadata ?? true,
          imageStyle: options.imageStyle ?? "solid",
          methods: categoriesAllowing(method),
        }),
      ],
      // A batch is collected as a zip long after the run, so there is no
      // response to hand a vault back in. It is sealed beside the artifact and
      // purged with the document; see DeliveryOptions.storeVault.
      { storeVault: true }
    )

    if (!outcome.ok) return skip("not-ready")

    await patched(exportId, documentId, {
      state: "exported",
      removed: outcome.delivered.primary.appliedRedactions,
    })
    return { stop: false }
  } catch (error) {
    // A verification failure is a verdict about this document, not weather, so
    // it is recorded rather than retried into the same answer. Anything else is
    // allowed to reach `paced` and be tried again.
    if (
      error instanceof ExportVerificationError ||
      error instanceof ReportLeakError
    ) {
      console.error(
        JSON.stringify({
          level: "error",
          context: "batches.export",
          exportId,
          documentId,
          errorCategory: "verification-failed",
        })
      )
      return skip("verification-failed")
    }

    throw error
  }
}

/**
 * The rest of the plan, named rather than left pending.
 *
 * A run that stopped — cancelled, or out of export allowance — has documents
 * nobody looked at, and a row that leaves them "pending" reads as a run that is
 * still going.
 */
async function settleRemaining(
  exportId: string,
  reason: SkipReason
): Promise<void> {
  "use step"

  const progress = await settlePending(exportId, reason)
  if (progress) await report(progress, "running")
}

/**
 * The final state.
 *
 * `updateMany` with the status in the filter rather than a plain update: a
 * cancel that landed while the last document was being exported has already
 * written "cancelled", and a run finishing afterwards must not quietly
 * un-cancel itself.
 */
async function finishExport(exportId: string): Promise<void> {
  "use step"

  const record = await prisma.batchExport.findUnique({
    where: { id: exportId },
    select: { documents: true, cancelRequested: true },
  })
  if (!record) return

  const documents = readDocuments(record.documents)
  const exported = documents.filter(
    (document) => document.state === "exported"
  ).length

  const status: BatchExportStatus = record.cancelRequested
    ? "cancelled"
    : exported > 0
      ? "ready"
      : "failed"
  const error =
    !record.cancelRequested && exported === 0
      ? "Nothing in this batch could be exported."
      : null

  await prisma.batchExport.updateMany({
    where: { id: exportId, status: { in: ["queued", "running"] } },
    data: { status, error },
  })

  await report(progressOf(documents), status, {
    type: "export.finished",
    error,
  })
  // Nothing follows, so the stream is closed rather than left for a reader to
  // wait out. A watcher sees the end frame and stops.
  await getWritable().close()
}

/**
 * Records a failure in the terms the reviewer needs, not the terms it arrived
 * in — the raw message is classified away for the same reason it is in the
 * processing pipeline: it is not guaranteed to be free of document content.
 */
async function failExport(exportId: string, raw: string): Promise<void> {
  "use step"

  console.error(
    JSON.stringify({
      level: "error",
      context: "batches.export",
      exportId,
      errorCategory: /no documents left|no longer exists/i.test(raw)
        ? "empty-batch"
        : "unexpected",
    })
  )

  const error = /no documents left/i.test(raw)
    ? "This batch has no documents left to export."
    : "The batch export could not be completed."

  await prisma.batchExport.updateMany({
    where: { id: exportId, status: { in: ["queued", "running"] } },
    data: { status: "failed", error },
  })

  const record = await prisma.batchExport.findUnique({
    where: { id: exportId },
    select: { documents: true },
  })

  await report(progressOf(readDocuments(record?.documents ?? null)), "failed", {
    type: "export.finished",
    error,
  })
  await getWritable().close()
}

export async function exportBatch(
  exportId: string
): Promise<{ exportId: string; status: string }> {
  "use workflow"

  try {
    const { documentIds, width } = await planExport(exportId)

    // A wave at a time rather than one document at a time.
    //
    // It used to be one, and that was never a decision about throughput — it
    // was the only shape the progress row could survive, because the row is a
    // single JSON column that every document rewrites. Two documents finishing
    // together would each add their own result to the copy they had read, and
    // the later write would erase the earlier one. `patchDocumentState` now
    // takes a row lock, so the reason is gone and the cost is not: a dozen
    // documents exported strictly in turn is a reviewer waiting for the sum of
    // twelve exports when the host could have been doing several at once.
    //
    // Bounded rather than unbounded, because every one of these rasterises
    // pages and holds a document in memory. `exportConcurrency()` is per
    // deployment profile and settable from the environment, and a wave is a
    // simple bound that keeps the stop semantics below honest: nothing after a
    // wave starts until every document in it has finished, so a cancel or an
    // exhausted allowance stops the run within one wave rather than after
    // however many were already in flight.
    for (let index = 0; index < documentIds.length; index += width) {
      const wave = documentIds.slice(index, index + width)

      const outcomes = await Promise.all(
        wave.map((documentId) => exportDocument(exportId, documentId))
      )

      // The first stop in the wave, in the plan's order, so the reason a run
      // stopped does not depend on which document happened to finish first.
      const stopped = outcomes.find((outcome) => outcome.stop)
      if (stopped?.stop) {
        // Everything left inherits the reason the run stopped, rather than
        // being left "pending" on a row that has finished moving.
        await settleRemaining(exportId, stopped.reason)
        break
      }
    }

    await finishExport(exportId)
    return { exportId, status: "finished" }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failExport(exportId, message)
    return { exportId, status: "failed" }
  }
}
