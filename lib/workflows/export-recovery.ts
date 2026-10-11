import { prisma } from "@/lib/database/prisma"
import {
  MAX_RECOVERIES,
  stuckRunMinutes,
  type CancelRun,
} from "@/lib/workflows/recovery"

/**
 * Export runs a dead worker left behind (#243).
 *
 * A worker killed hard (`SIGKILL`, out of memory, a node gone) keeps the lock
 * on its step job for about four hours, and #182's recovery looks at document
 * processing only. A background export (#187) or a batch export caught by one
 * sat at "running" all that time, with a progress bar that never moved. The
 * scale-in load test (#190) found one.
 *
 * The same rule as documents: a run whose row has not changed for
 * `ANONIFY_STUCK_RUN_MINUTES` is cancelled and started again on the same
 * export. That is safe because both workflows resume: a single export's
 * variants write to fixed artifact ids, so one done before is overwritten,
 * not duplicated; a batch export records its plan and skips the documents it
 * has settled. Rows change as a run works (progress at least every second
 * while drawing, every document in a batch), so a quiet one has stopped.
 *
 * After `MAX_RECOVERIES` restarts the export fails, with a sentence the
 * dialog shows: something about it is killing the process exporting it.
 * One whose reviewer asked to cancel is simply marked cancelled.
 */

/** Starts a run of one export workflow on an existing export. */
export type StartExport = (exportId: string) => Promise<string>

export type ExportRestarts = {
  document: StartExport
  batch: StartExport
}

export type ExportRecoveryResult = {
  restarted: number
  failed: number
  cancelled: number
}

/** Shown in the export dialog. */
export const EXPORT_LOST_MESSAGE =
  "The server exporting this stopped before it finished, more than once. Start the export again."

const BATCH = 50
const LIVE = ["queued", "running"]

type Candidate = {
  id: string
  workflowRunId: string | null
  recoveries: number
  cancelRequested: boolean
}

/** One table's reads and guarded writes, so the rule is written once. */
type ExportTable = {
  kind: "document" | "batch"
  find: (cutoff: Date) => Promise<Candidate[]>
  /** Applies `data` only if the row is still on `runId` and live. */
  claim: (
    id: string,
    runId: string,
    data: {
      status?: string
      error?: string
      workflowRunId?: string
      recoveries?: number
    }
  ) => Promise<number>
}

const select = {
  id: true,
  workflowRunId: true,
  recoveries: true,
  cancelRequested: true,
} as const

const TABLES: ExportTable[] = [
  {
    kind: "document",
    find: (cutoff) =>
      prisma.documentExport.findMany({
        where: {
          status: { in: LIVE },
          workflowRunId: { not: null },
          updatedAt: { lt: cutoff },
        },
        orderBy: { updatedAt: "asc" },
        take: BATCH,
        select,
      }),
    claim: async (id, runId, data) =>
      (
        await prisma.documentExport.updateMany({
          where: { id, workflowRunId: runId, status: { in: LIVE } },
          data,
        })
      ).count,
  },
  {
    kind: "batch",
    find: (cutoff) =>
      prisma.batchExport.findMany({
        where: {
          status: { in: LIVE },
          workflowRunId: { not: null },
          updatedAt: { lt: cutoff },
        },
        orderBy: { updatedAt: "asc" },
        take: BATCH,
        select,
      }),
    claim: async (id, runId, data) =>
      (
        await prisma.batchExport.updateMany({
          where: { id, workflowRunId: runId, status: { in: LIVE } },
          data,
        })
      ).count,
  },
]

function log(fields: Record<string, unknown>) {
  console.log(
    JSON.stringify({ level: "info", context: "exports.recovery", ...fields })
  )
}

export async function recoverLostExports(
  cancelRun: CancelRun,
  restarts: ExportRestarts,
  {
    now = new Date(),
    minutes = stuckRunMinutes(),
  }: { now?: Date; minutes?: number } = {}
): Promise<ExportRecoveryResult> {
  const cutoff = new Date(now.getTime() - minutes * 60_000)
  const result: ExportRecoveryResult = { restarted: 0, failed: 0, cancelled: 0 }

  for (const table of TABLES) {
    for (const lost of await table.find(cutoff)) {
      const runId = lost.workflowRunId!

      // Cancelled first, so the old run cannot write over what happens next.
      // A run that will not cancel is left for the next sweep.
      try {
        await cancelRun(runId)
      } catch (error) {
        log({
          level: "warn",
          kind: table.kind,
          exportId: lost.id,
          workflowId: runId,
          message: `could not cancel the lost run: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }

      if (lost.cancelRequested) {
        if (await table.claim(lost.id, runId, { status: "cancelled" }))
          result.cancelled += 1
        continue
      }

      if (lost.recoveries >= MAX_RECOVERIES) {
        const claimed = await table.claim(lost.id, runId, {
          status: "failed",
          error: EXPORT_LOST_MESSAGE,
        })
        if (claimed === 0) continue
        result.failed += 1
        log({
          level: "warn",
          kind: table.kind,
          exportId: lost.id,
          workflowId: runId,
          recoveries: lost.recoveries,
          message: "the export run was lost again, and the export has failed",
        })
        continue
      }

      const start =
        table.kind === "document" ? restarts.document : restarts.batch
      let next: string
      try {
        next = await start(lost.id)
      } catch (error) {
        log({
          level: "warn",
          kind: table.kind,
          exportId: lost.id,
          message: `could not start the export again: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      // Moved to the new run only if nothing moved it meanwhile; if something
      // did, the new run is surplus, and is stopped.
      const claimed = await table.claim(lost.id, runId, {
        workflowRunId: next,
        recoveries: lost.recoveries + 1,
      })
      if (claimed === 0) {
        await cancelRun(next).catch(() => undefined)
        continue
      }
      result.restarted += 1
      log({
        kind: table.kind,
        exportId: lost.id,
        workflowId: next,
        lostWorkflowId: runId,
        recoveries: lost.recoveries + 1,
        stuckMinutes: minutes,
        message:
          "the export run stopped making progress, so it was started again",
      })
    }
  }

  return result
}
