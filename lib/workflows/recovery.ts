import type { Prisma } from "@/lib/database/generated/client"
import { prisma } from "@/lib/database/prisma"
import { isPendingRun } from "@/lib/documents/admission"
import { newEventId } from "@/lib/documents/ids"
import { failureForCode } from "@/lib/workflows/failure"

/**
 * Documents left behind by a worker that died (#182).
 *
 * A worker killed hard (out of memory, `SIGKILL` after its grace period, a
 * node gone) holds the lock on the job it was running until graphile-worker
 * decides the job is abandoned, about four hours later, and the document sits
 * at "extracting" for all of it. Admission's backstop only finds documents
 * that never got a run, not runs that stopped moving.
 *
 * This does, from the sweep. A document a run is working on whose last sign
 * of progress, its row changing or a processing event, is older than
 * `ANONIFY_STUCK_RUN_MINUTES` (20) has its run cancelled and goes back to the
 * queue with no run, so admission starts a fresh one. Every step is safe to
 * run again: ingest returns early once the source is stored, and usage is
 * charged once, by a flag on the row (docs/workflow.md §3).
 *
 * Twice at most per document. The third time it fails with `worker-lost`,
 * which is retryable: something about this document, or this deployment, is
 * killing the process that reads it, and a loop would hide that.
 *
 * Set the threshold above the longest healthy step and the longest a job can
 * wait in a backed-up queue: a run that is only waiting its turn looks the
 * same from here as one whose worker died.
 */

type Env = Record<string, string | undefined>

export const STUCK_RUN_MINUTES_ENV = "ANONIFY_STUCK_RUN_MINUTES"
export const DEFAULT_STUCK_RUN_MINUTES = 20
/** Restarts before a document is failed instead. */
export const MAX_RECOVERIES = 2

const WORKING_STATUSES = ["queued", "extracting", "normalizing", "analyzing"]

/** At most this many documents per sweep, so one sweep stays short. */
const BATCH = 100

/** `ANONIFY_STUCK_RUN_MINUTES` (1–1440). A malformed value throws. */
export function stuckRunMinutes(env: Env = process.env): number {
  const raw = env[STUCK_RUN_MINUTES_ENV]?.trim()
  if (!raw) return DEFAULT_STUCK_RUN_MINUTES
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 1440)
    throw new Error(
      `${STUCK_RUN_MINUTES_ENV} must be a whole number from 1 to 1440`
    )
  return value
}

/** Cancels a workflow run, supplied by the caller (see admission's StartRun). */
export type CancelRun = (runId: string) => Promise<void>

export type RecoveryResult = { requeued: number; failed: number }

function recoveriesOf(metadata: Prisma.JsonValue | null): number {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).recoveries
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return 0
}

function log(fields: Record<string, unknown>) {
  console.log(
    JSON.stringify({ level: "info", context: "workflows.recovery", ...fields })
  )
}

export async function recoverLostRuns(
  cancelRun: CancelRun,
  {
    now = new Date(),
    minutes = stuckRunMinutes(),
  }: { now?: Date; minutes?: number } = {}
): Promise<RecoveryResult> {
  const cutoff = new Date(now.getTime() - minutes * 60_000)
  const result: RecoveryResult = { requeued: 0, failed: 0 }

  const candidates = await prisma.document.findMany({
    where: {
      workflowRunId: { not: null },
      status: { in: WORKING_STATUSES },
      updatedAt: { lt: cutoff },
      expiresAt: { gt: now },
    },
    orderBy: { updatedAt: "asc" },
    take: BATCH,
    select: { id: true, workflowRunId: true, metadata: true },
  })

  for (const document of candidates) {
    const runId = document.workflowRunId!

    // A run that is still writing events is moving, whatever its row says.
    const latest = await prisma.processingEvent.findFirst({
      where: { documentId: document.id },
      orderBy: { at: "desc" },
      select: { at: true },
    })
    if (latest && latest.at >= cutoff) continue

    // Cancelled first, so the old run cannot write over what happens next.
    // A run that will not cancel is left for the next sweep. A claim whose
    // run never started (the admitting process died in between) has nothing
    // to cancel.
    try {
      if (!isPendingRun(runId)) await cancelRun(runId)
    } catch (error) {
      log({
        level: "warn",
        documentId: document.id,
        workflowId: runId,
        message: `could not cancel the lost run: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    const recoveries = recoveriesOf(document.metadata)
    const metadata = {
      ...(document.metadata && typeof document.metadata === "object"
        ? (document.metadata as Record<string, unknown>)
        : {}),
      recoveries: recoveries + 1,
    } as Prisma.InputJsonValue

    // Only if nothing else moved it meanwhile: the run finishing, or another
    // replica's sweep getting here first.
    const guard = {
      id: document.id,
      workflowRunId: runId,
      status: { in: WORKING_STATUSES },
    }

    if (recoveries >= MAX_RECOVERIES) {
      const failure = failureForCode("worker-lost")
      const claimed = await prisma.document.updateMany({
        where: guard,
        data: {
          status: "failed",
          error: failure.message,
          errorCode: failure.code,
          metadata,
        },
      })
      if (claimed.count === 0) continue
      await prisma.processingEvent.create({
        data: {
          id: newEventId(),
          documentId: document.id,
          type: "document.failed",
          payload: { code: failure.code, retryable: failure.retryable },
        },
      })
      result.failed += 1
      log({
        level: "warn",
        documentId: document.id,
        workflowId: runId,
        recoveries,
        errorCategory: failure.code,
        message: "the run was lost again, and the document has failed",
      })
      continue
    }

    const claimed = await prisma.document.updateMany({
      where: guard,
      data: { status: "queued", workflowRunId: null, metadata },
    })
    if (claimed.count === 0) continue
    result.requeued += 1
    log({
      documentId: document.id,
      workflowId: runId,
      recoveries: recoveries + 1,
      stuckMinutes: minutes,
      message:
        "the run stopped making progress, so the document is queued again",
    })
  }

  return result
}
