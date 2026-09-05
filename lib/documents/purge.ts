import { prisma } from "@/lib/database/prisma"
import { deleteObject } from "@/lib/storage/blob"

/**
 * Deleting everything a document produced.
 *
 * Both the scheduled expiry sweep and an explicit "delete now" go through here,
 * so there is one list of what a document owns — source, the plaintext upload
 * if ingest never got to it, the normalized model, and every export with the
 * report that accompanied it. A helper that forgets one of those leaves bytes
 * behind that nothing is tracking any more, which is exactly the failure a
 * temporary-by-default product cannot have.
 */

export type PurgeResult = {
  objectsDeleted: number
  storageCleared: boolean
}

export type PurgeOutcome = PurgeResult & {
  recordDeleted: boolean
  /**
   * Every document actually removed, this one and its attachments. The caller
   * needs it because a sweep can hold a parent and one of its children in the
   * same page, and the second must not be purged twice.
   */
  deletedIds: string[]
}

export type PurgeableDocument = {
  id: string
  sourceBlobKey: string | null
  uploadBlobKey: string | null
  processedBlobKey: string | null
  normalizedBlobKey: string | null
  exports: { blobKey: string; reportBlobKey?: string | null }[]
}

export const PURGE_SELECT = {
  id: true,
  sourceBlobKey: true,
  uploadBlobKey: true,
  processedBlobKey: true,
  normalizedBlobKey: true,
  exports: { select: { blobKey: true, reportBlobKey: true } },
} as const

/** Removes the stored objects. Idempotent: an object already gone counts. */
export async function purgeStorage(
  document: PurgeableDocument
): Promise<PurgeResult> {
  const keys = [
    document.sourceBlobKey,
    document.uploadBlobKey,
    document.processedBlobKey,
    document.normalizedBlobKey,
    ...document.exports.flatMap((artifact) => [
      artifact.blobKey,
      artifact.reportBlobKey ?? null,
    ]),
  ].filter((key): key is string => Boolean(key))

  let objectsDeleted = 0
  let storageCleared = true

  for (const key of keys) {
    try {
      await deleteObject(key)
      objectsDeleted += 1
    } catch {
      storageCleared = false
    }
  }

  return { objectsDeleted, storageCleared }
}

/**
 * Removes the storage and then the record. The order matters: the row is the
 * only thing that knows where the bytes are, so it goes last and only if they
 * are gone — a failed sweep is retried rather than leaving orphans.
 *
 * Attachments go first, and they have to. A document expanded out of a message
 * is a document in its own right — its own sealed source, its own normalized
 * model, its own exports — and its row cascades from its parent's. Deleting
 * the message without coming here first would take away the only record of
 * where those bytes are while leaving the bytes exactly where they were, which
 * is the orphan this whole file exists to prevent. It also means deleting a
 * message deletes what came inside it, which is what somebody pressing delete
 * on an email means.
 */
export async function purgeDocument(
  document: PurgeableDocument
): Promise<PurgeOutcome> {
  let objectsDeleted = 0
  let cleared = true
  const deletedIds: string[] = []

  const attachments = await prisma.document.findMany({
    where: { parentDocumentId: document.id },
    select: PURGE_SELECT,
  })

  // Recursion is bounded by the expansion depth limit; see
  // lib/documents/eml/attachments.ts.
  for (const attachment of attachments) {
    const child = await purgeDocument(attachment)
    objectsDeleted += child.objectsDeleted
    deletedIds.push(...child.deletedIds)
    if (!child.recordDeleted) cleared = false
  }

  const own = await purgeStorage(document)
  objectsDeleted += own.objectsDeleted
  cleared = cleared && own.storageCleared

  if (!cleared) {
    return { objectsDeleted, storageCleared: false, recordDeleted: false, deletedIds }
  }

  // Redactions, rules, events and exports cascade from the document.
  await prisma.document.delete({ where: { id: document.id } })
  return {
    objectsDeleted,
    storageCleared: true,
    recordDeleted: true,
    deletedIds: [...deletedIds, document.id],
  }
}
