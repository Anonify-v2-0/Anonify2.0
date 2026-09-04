import { prisma } from "@/lib/database/prisma"
import { pruneRateLimits } from "@/lib/security/rate-limit"
import { deleteObject } from "@/lib/storage/blob"

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
  rateLimitsPruned: number
}

/** Bounded so a single run cannot exceed its function's time budget. */
const BATCH_SIZE = 50

export async function cleanupExpired(now = new Date()): Promise<CleanupResult> {
  const expired = await prisma.document.findMany({
    where: { expiresAt: { lte: now } },
    select: {
      id: true,
      sourceBlobKey: true,
      uploadBlobKey: true,
      processedBlobKey: true,
      normalizedBlobKey: true,
      exports: { select: { blobKey: true } },
    },
    take: BATCH_SIZE,
  })

  let objectsDeleted = 0
  let documentsDeleted = 0
  let failures = 0

  for (const document of expired) {
    const keys = [
      document.sourceBlobKey,
      document.uploadBlobKey,
      document.processedBlobKey,
      document.normalizedBlobKey,
      ...document.exports.map((artifact) => artifact.blobKey),
    ].filter((key): key is string => Boolean(key))

    let storageCleared = true
    for (const key of keys) {
      try {
        await deleteObject(key)
        objectsDeleted += 1
      } catch {
        // Leave the record in place so the next run retries this document
        // rather than orphaning bytes nobody is tracking any more.
        storageCleared = false
      }
    }

    if (!storageCleared) {
      failures += 1
      continue
    }

    // Redactions, rules, events and exports cascade from the document.
    await prisma.document.delete({ where: { id: document.id } })
    documentsDeleted += 1
  }

  const rateLimitsPruned = await pruneRateLimits().catch(() => 0)

  console.log(
    JSON.stringify({
      level: "info",
      context: "cleanup",
      documentsDeleted,
      objectsDeleted,
      failures,
      rateLimitsPruned,
    })
  )

  return { documentsDeleted, objectsDeleted, failures, rateLimitsPruned }
}

/** Marks expired documents so the workspace stops serving them mid-window. */
export async function markExpired(now = new Date()): Promise<number> {
  const result = await prisma.document.updateMany({
    where: { expiresAt: { lte: now }, status: { not: "expired" } },
    data: { status: "expired" },
  })
  return result.count
}
