import { withAdvisoryLock } from "@/lib/database/locks"
import { admitStalled, type StartRun } from "@/lib/documents/admission"
import {
  cleanupExpired,
  cleanupSettings,
  markExpired,
  type CleanupResult,
} from "@/lib/workflows/cleanup"
import {
  recoverLostRuns,
  type CancelRun,
  type RecoveryResult,
} from "@/lib/workflows/recovery"

/**
 * The sweep: everything that has to happen on a schedule, in one place (#183).
 *
 * 1. Mark documents past their TTL expired, and purge them with everything
 *    they produced: the "temporary by default" promise.
 * 2. Restart runs a dead worker left behind (#182).
 * 3. Admit documents stuck in the queue: admission's backstop.
 *
 * Three callers run it, and they share one lock, so mixing them is safe and
 * only one sweep runs at a time across every replica:
 *
 * - the built-in scheduler, in every worker (lib/runtime/scheduler.ts);
 * - `/api/cron/cleanup`, for Vercel's cron and any platform scheduler;
 * - `anonify cleanup` / `pnpm cleanup`, for job-style schedulers.
 *
 * Starting and cancelling runs are passed in rather than imported, for the
 * same reason as admission's `StartRun`: the CLI is bundled without the
 * workflow runtime, and a sweep without them does the expiry only.
 */

export const SWEEP_LOCK = "anonify.sweep"

export type SweepOptions = {
  /** How long the purge keeps taking pages; see `cleanupExpired`. */
  budgetMs?: number
  /** Starts a run; without it, nothing is admitted. */
  startRun?: StartRun
  /** Cancels a run; without it, lost runs are left for a sweep that can. */
  cancelRun?: CancelRun
  now?: Date
}

export type SweepResult = CleanupResult & {
  marked: number
  recovered: RecoveryResult
  admitted: number
  durationMs: number
}

/** Room past the purge's budget for recovery and admission. */
const AFTER_PURGE_MS = 60_000

export async function sweep(options: SweepOptions = {}): Promise<SweepResult> {
  const began = Date.now()
  const budgetMs = options.budgetMs ?? cleanupSettings().budgetMs
  const holdMs = Number.isFinite(budgetMs)
    ? budgetMs + AFTER_PURGE_MS
    : Number.MAX_SAFE_INTEGER

  const outcome = await withAdvisoryLock(SWEEP_LOCK, holdMs, async () => {
    const marked = await markExpired()
    // The whole backlog, within the budget. Under this sweep's lock, so the
    // purge does not take one of its own.
    const result = await cleanupExpired({
      budgetMs,
      now: options.now,
      locked: true,
    })
    // Before admission, so a run restarted here is started in this sweep.
    const recovered = options.cancelRun
      ? await recoverLostRuns(options.cancelRun)
      : { requeued: 0, failed: 0 }
    // After the purge, not before: a document that has just expired should
    // not be admitted a moment before it is deleted.
    const admitted = options.startRun ? await admitStalled(options.startRun) : 0
    return { ...result, marked, recovered, admitted }
  })

  const durationMs = Date.now() - began
  if (outcome.acquired) return { ...outcome.result, durationMs }

  return {
    marked: 0,
    documentsDeleted: 0,
    objectsDeleted: 0,
    failures: 0,
    batchesPruned: 0,
    ownerRulesPruned: 0,
    rateLimitsPruned: 0,
    remaining: true,
    skipped: "another sweep is running",
    recovered: { requeued: 0, failed: 0 },
    admitted: 0,
    durationMs,
  }
}
