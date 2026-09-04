import { prisma } from "@/lib/database/prisma"
import { deleteObject } from "@/lib/storage/blob"

/**
 * Deleting everything a document produced.
 *
 * Both the scheduled expiry sweep and an explicit "delete now" go through here,
 * so there is one list of what a document owns — source, the plaintext upload
 * if ingest never got to it, the normalized model, and every export. A helper
 * that forgets one of those leaves bytes behind that nothing is tracking any
 * more, which is exactly the failure a temporary-by-default product cannot have.
 */

export type PurgeResult = {
  objectsDeleted: number
  storageCleared: boolean
}

export type PurgeableDocument = {
  id: string
  sourceBlobKey: string | null
  uploadBlobKey: string | null
  processedBlobKey: string | null
  normalizedBlobKey: string | null
  exports: { blobKey: string }[]
}

export const PURGE_SELECT = {
  id: true,
  sourceBlobKey: true,
  uploadBlobKey: true,
  processedBlobKey: true,
  normalizedBlobKey: true,
  exports: { select: { blobKey: true } },
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
    ...document.exports.map((artifact) => artifact.blobKey),
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
 */
export async function purgeDocument(
  document: PurgeableDocument
): Promise<PurgeResult & { recordDeleted: boolean }> {
  const result = await purgeStorage(document)
  if (!result.storageCleared) {
    return { ...result, recordDeleted: false }
  }

  // Redactions, rules, events and exports cascade from the document.
  await prisma.document.delete({ where: { id: document.id } })
  return { ...result, recordDeleted: true }
}
