import { prisma } from "@/lib/database/prisma"
import { listBatchDocuments, type DocumentListItem } from "@/lib/documents/listing"
import { AccessError } from "@/lib/security/access-control"
import type { BatchPlacement } from "@/types/document"

/**
 * Batches.
 *
 * A batch is an upload of several documents reviewed as one pass. What makes it
 * worth having is not the upload — it is that a decision made once is not made
 * again on the next file: "this recurring name is a colleague, not a subject"
 * is answered in the document where it came up and carried to the rest.
 *
 * What a batch deliberately does *not* do is couple the documents. Each keeps
 * its own run, its own quota accounting and its own failure, so one document
 * failing leaves the others exactly where they were.
 */

export type BatchRuleSummary = {
  id: string
  pattern: string
  category: string
  createdAt: string
  /** Where the reviewer made the decision, when that document still exists. */
  originDocumentId: string | null
  /** How many documents in the batch have this decision applied. */
  documents: number
  /** Redactions it has produced across those documents. */
  redactions: number
}

export type BatchOverview = {
  id: string
  createdAt: string
  documents: DocumentListItem[]
  rules: BatchRuleSummary[]
}

export type OwnedBatch = {
  id: string
  createdAt: Date
  userFingerprint: string
}

/**
 * Ownership, checked against the batch itself rather than inferred from one of
 * its documents — a batch whose only remaining document has expired is still
 * the caller's, and one that is not theirs is reported as missing.
 */
export async function requireBatch(
  batchId: string,
  ownerKey: string | undefined
): Promise<OwnedBatch> {
  if (!ownerKey) throw new AccessError("No session", 401)

  const batch = await prisma.batch.findUnique({ where: { id: batchId } })
  if (!batch || batch.userFingerprint !== ownerKey) {
    throw new AccessError("Batch not found", 404)
  }

  return batch
}

export async function batchOverview(batch: OwnedBatch): Promise<BatchOverview> {
  const [documents, rules] = await Promise.all([
    listBatchDocuments(batch.id),
    prisma.batchRule.findMany({
      where: { batchId: batch.id },
      orderBy: { createdAt: "asc" },
    }),
  ])

  const copies = await prisma.globalRule.findMany({
    where: { batchRuleId: { in: rules.map((rule) => rule.id) } },
    select: { id: true, documentId: true, batchRuleId: true },
  })

  const produced = copies.length
    ? await prisma.redaction.groupBy({
        by: ["ruleId"],
        where: { ruleId: { in: copies.map((copy) => copy.id) } },
        _count: { _all: true },
      })
    : []

  const countByRuleId = new Map(
    produced.map((row) => [row.ruleId, row._count._all])
  )

  return {
    id: batch.id,
    createdAt: batch.createdAt.toISOString(),
    documents,
    rules: rules.map((rule) => {
      const mine = copies.filter((copy) => copy.batchRuleId === rule.id)
      return {
        id: rule.id,
        pattern: rule.pattern,
        category: rule.category,
        createdAt: rule.createdAt.toISOString(),
        originDocumentId: rule.originDocumentId,
        documents: mine.length,
        redactions: mine.reduce(
          (total, copy) => total + (countByRuleId.get(copy.id) ?? 0),
          0
        ),
      }
    }),
  }
}

/** Where a document sits in its batch, for the workspace's own navigation. */
export async function batchPositionFor(
  documentId: string,
  batchId: string | null
): Promise<BatchPlacement | null> {
  if (!batchId) return null

  const [siblings, carried] = await Promise.all([
    listBatchDocuments(batchId),
    prisma.globalRule.count({
      where: { documentId, batchRuleId: { not: null } },
    }),
  ])

  const index = siblings.findIndex((document) => document.id === documentId)
  if (index === -1) return null

  return {
    batchId,
    position: index + 1,
    total: siblings.length,
    previousId: index > 0 ? siblings[index - 1].id : null,
    nextId: index < siblings.length - 1 ? siblings[index + 1].id : null,
    carriedRules: carried,
  }
}

/**
 * Batches whose documents have all expired or been deleted.
 *
 * The batch row itself holds the decisions, which are document content in the
 * plainest sense — a name somebody typed. Nothing points at them once the
 * documents are gone, so they go too, on the same sweep.
 */
export async function pruneEmptyBatches(): Promise<number> {
  const result = await prisma.batch.deleteMany({
    where: { documents: { none: {} } },
  })
  return result.count
}
