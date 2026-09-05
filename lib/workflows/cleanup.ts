import { prisma } from "@/lib/database/prisma"
import { pruneEmptyBatches } from "@/lib/documents/batches"
import { purgeDocument, PURGE_SELECT } from "@/lib/documents/purge"
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
 */

export type CleanupResult = {
  documentsDeleted: number
  objectsDeleted: number
  failures: number
  batchesPruned: number
  rateLimitsPruned: number
}

/** Bounded so a single run cannot exceed its function's time budget. */
const BATCH_SIZE = 50

export async function cleanupExpired(now = new Date()): Promise<CleanupResult> {
  const expired = await prisma.document.findMany({
    where: { expiresAt: { lte: now } },
    select: PURGE_SELECT,
    take: BATCH_SIZE,
  })

  let objectsDeleted = 0
  let documentsDeleted = 0
  let failures = 0

  for (const document of expired) {
    const result = await purgeDocument(document)
    objectsDeleted += result.objectsDeleted

    // A document whose storage did not clear keeps its record, so the next run
    // retries it rather than orphaning bytes nobody is tracking any more.
    if (result.recordDeleted) documentsDeleted += 1
    else failures += 1
  }

  // A batch holds the decisions taken across its documents — patterns a person
  // typed, which is document content in the plainest sense. Once its documents
  // are gone nothing points at them, so they go on the same sweep.
  const batchesPruned = await pruneEmptyBatches().catch(() => 0)
  const rateLimitsPruned = await pruneRateLimits().catch(() => 0)

  console.log(
    JSON.stringify({
      level: "info",
      context: "cleanup",
      documentsDeleted,
      objectsDeleted,
      failures,
      batchesPruned,
      rateLimitsPruned,
    })
  )

  return {
    documentsDeleted,
    objectsDeleted,
    failures,
    batchesPruned,
    rateLimitsPruned,
  }
}

/** Marks expired documents so the workspace stops serving them mid-window. */
export async function markExpired(now = new Date()): Promise<number> {
  const result = await prisma.document.updateMany({
    where: { expiresAt: { lte: now }, status: { not: "expired" } },
    data: { status: "expired" },
  })
  return result.count
}
