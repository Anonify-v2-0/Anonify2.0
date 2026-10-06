import { mapWithConcurrency } from "@/lib/concurrency"
import { withAdvisoryLock } from "@/lib/database/locks"
import { prisma } from "@/lib/database/prisma"
import { pruneEmptyBatches } from "@/lib/documents/batches"
import { purgeDocument, PURGE_SELECT } from "@/lib/documents/purge"
import { pruneOwnerRules } from "@/lib/redaction/owner-rules"
import { pruneRateLimits } from "@/lib/security/rate-limit"

/**
 * Expiry cleanup.
 *
 * A temporary document that outlives its TTL is a broken promise, so this
 * removes everything it produced: the source, the normalized model, every
 * export, and the database rows that point at them. It is idempotent by
 * construction — a blob that is already gone counts as deleted, and a document
 * is only removed after its storage is — so a retry after a partial failure
 * finishes the job rather than repeating it.
 *
 * A run works through the whole backlog, a page at a time, until it is empty
 * or the time budget is spent (#170). It used to stop at 50 documents, which
 * on a once-a-day cron meant at most 50 a day were ever deleted. Each page is
 * purged several documents at once, and only one sweep runs at a time across
 * every replica: another that finds one running steps aside.
 */

export type CleanupResult = {
  documentsDeleted: number
  objectsDeleted: number
  failures: number
  batchesPruned: number
  /** Global rules nobody had used for the idle window. */
  ownerRulesPruned: number
  rateLimitsPruned: number
  /** Expired documents left for the next run, because the budget ran out. */
  remaining: boolean
  /** Set when another sweep held the lock, and this one did nothing. */
  skipped?: string
}

export type CleanupOptions = {
  now?: Date
  /**
   * How long to keep taking pages. ANONIFY_CLEANUP_BUDGET_MS, else 240000:
   * inside the cron route's 300 seconds, with room for the prunes. The CLI
   * passes Infinity.
   */
  budgetMs?: number
  /** Documents purged at once. ANONIFY_CLEANUP_CONCURRENCY, else 8. */
  concurrency?: number
}

/** Documents read at a time. */
const PAGE = 50
export const DEFAULT_CLEANUP_BUDGET_MS = 240_000
export const DEFAULT_CLEANUP_CONCURRENCY = 8
const LOCK = "anonify.cleanup"

function positiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  max: number
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be a whole number from 1 to ${max}`)
  return value
}

/** ANONIFY_CLEANUP_BUDGET_MS and ANONIFY_CLEANUP_CONCURRENCY; a malformed value throws. */
export function cleanupSettings(
  env: Record<string, string | undefined> = process.env
): { budgetMs: number; concurrency: number } {
  return {
    budgetMs: positiveInteger(
      env,
      "ANONIFY_CLEANUP_BUDGET_MS",
      DEFAULT_CLEANUP_BUDGET_MS,
      86_400_000
    ),
    concurrency: positiveInteger(
      env,
      "ANONIFY_CLEANUP_CONCURRENCY",
      DEFAULT_CLEANUP_CONCURRENCY,
      64
    ),
  }
}

export async function cleanupExpired(
  options: CleanupOptions = {}
): Promise<CleanupResult> {
  const settings = cleanupSettings()
  const now = options.now ?? new Date()
  const budgetMs = options.budgetMs ?? settings.budgetMs
  const concurrency = options.concurrency ?? settings.concurrency

  const outcome = await withAdvisoryLock(
    LOCK,
    Number.isFinite(budgetMs) ? budgetMs : Number.MAX_SAFE_INTEGER,
    () => sweep(now, budgetMs, concurrency)
  )
  if (outcome.acquired) return outcome.result

  const skipped: CleanupResult = {
    documentsDeleted: 0,
    objectsDeleted: 0,
    failures: 0,
    batchesPruned: 0,
    ownerRulesPruned: 0,
    rateLimitsPruned: 0,
    remaining: true,
    skipped: "another sweep is running",
  }
  console.log(JSON.stringify({ level: "info", context: "cleanup", ...skipped }))
  return skipped
}

async function sweep(
  now: Date,
  budgetMs: number,
  concurrency: number
): Promise<CleanupResult> {
  const began = Date.now()
  let objectsDeleted = 0
  let documentsDeleted = 0
  let failures = 0
  let remaining = false

  // A message and the attachments it was expanded into share an expiry, so a
  // page of this sweep routinely holds both. Purging the message takes its
  // attachments with it — their rows cascade from its — so the ones already
  // gone are skipped rather than purged into a row that is no longer there.
  const purged = new Set<string>()
  // A document that cannot be purged keeps its row, and would be read again
  // on the next page of this run. It is retried next run, not next page.
  const failed = new Set<string>()

  for (;;) {
    if (Date.now() - began >= budgetMs) {
      remaining =
        (await prisma.document.count({
          where: { expiresAt: { lte: now }, id: { notIn: [...failed] } },
          take: 1,
        })) > 0
      break
    }

    const page = await prisma.document.findMany({
      where: {
        expiresAt: { lte: now },
        // What failed stays expired, and is left for the next run.
        id: { notIn: [...failed] },
      },
      select: { ...PURGE_SELECT, parentDocumentId: true },
      orderBy: { expiresAt: "asc" },
      take: PAGE,
    })
    if (page.length === 0) break

    // A child on the same page as its parent is purged by the parent, so it
    // is left out rather than purged by two workers at once.
    const onPage = new Set(page.map((document) => document.id))
    const work = page.filter(
      (document) =>
        !purged.has(document.id) &&
        !failed.has(document.id) &&
        (!document.parentDocumentId || !onPage.has(document.parentDocumentId))
    )
    // Nothing on the page that this run has not already dealt with: stop,
    // rather than read the same page again.
    if (work.length === 0) break

    await mapWithConcurrency(work, concurrency, async (document) => {
      if (purged.has(document.id)) return

      // One document that cannot be purged must not cost the rest of the page
      // their deletion: count it, say so, and carry on. The next run retries
      // it, because its row is still there.
      let result: Awaited<ReturnType<typeof purgeDocument>>
      try {
        result = await purgeDocument(document)
      } catch {
        failures += 1
        failed.add(document.id)
        console.error(
          JSON.stringify({
            level: "error",
            context: "cleanup.document",
            documentId: document.id,
            errorCategory: "unexpected",
          })
        )
        return
      }
      objectsDeleted += result.objectsDeleted
      documentsDeleted += result.deletedIds.length
      for (const id of result.deletedIds) purged.add(id)

      // A document whose storage did not clear keeps its record, so the next
      // run retries it rather than orphaning bytes nobody is tracking any
      // more.
      if (!result.recordDeleted) {
        failures += 1
        failed.add(document.id)
      }
    })
  }

  // A batch holds the decisions taken across its documents — patterns a person
  // typed, which is document content in the plainest sense. Once its documents
  // are gone nothing points at them, so they go on the same sweep.
  const batchesPruned = await pruneEmptyBatches().catch(() => 0)
  // Global rules outlive documents, so they are not reached by the purge above.
  // One unused for as long as the session that owns it can live is a pattern
  // kept for nobody.
  const ownerRulesPruned = await pruneOwnerRules(now).catch(() => 0)
  const rateLimitsPruned = await pruneRateLimits().catch(() => 0)

  const result: CleanupResult = {
    documentsDeleted,
    objectsDeleted,
    failures,
    batchesPruned,
    ownerRulesPruned,
    rateLimitsPruned,
    remaining,
  }
  console.log(
    JSON.stringify({
      level: "info",
      context: "cleanup",
      ...result,
      durationMs: Date.now() - began,
    })
  )
  return result
}

/** Marks expired documents so the workspace stops serving them mid-window. */
export async function markExpired(now = new Date()): Promise<number> {
  const result = await prisma.document.updateMany({
    where: { expiresAt: { lte: now }, status: { not: "expired" } },
    data: { status: "expired" },
  })
  return result.count
}
