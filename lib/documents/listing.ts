import type { Prisma } from "@/lib/database/generated/client"
import { prisma } from "@/lib/database/prisma"
import type { DocumentKind } from "@/types/document"

/**
 * The caller's own documents.
 *
 * Scoped to the owner key and nothing else — this is the same identity that
 * guards every other read, so the list can never surface somebody else's work.
 * Expired documents are excluded rather than shown as broken links: they are
 * already unreachable, and the sweep will remove them shortly.
 */

export type DocumentListItem = {
  id: string
  originalName: string
  kind: DocumentKind
  mimeType: string
  size: number
  status: string
  pageCount: number | null
  createdAt: string
  expiresAt: string
  error: string | null
  errorCode: string | null
  hasExport: boolean
  batchId: string | null
  counts: {
    total: number
    suggested: number
    accepted: number
  }
}

/** A generous ceiling; the anonymous demo quota keeps real lists far smaller. */
const LIST_LIMIT = 50

/**
 * Bind parameters a single `in` list is allowed. Postgres stops at 32,767 per
 * statement; a batch is bounded by the mailbox limits, which a self-hosted
 * install may raise as far as it likes.
 */
const IN_LIST_LIMIT = 10_000

export async function listDocuments(
  ownerKey: string | undefined,
  now = new Date()
): Promise<DocumentListItem[]> {
  if (!ownerKey) return []
  return query({ userFingerprint: ownerKey, expiresAt: { gt: now } }, [
    { createdAt: "desc" },
  ])
}

function inBatch(batchId: string, now: Date): Prisma.DocumentWhereInput {
  return { batchId, expiresAt: { gt: now } }
}

/**
 * Oldest first, and ties broken by id: documents expanded out of one mailbox
 * can share a creation time, and without a tie-break the database is free to
 * put them in a different order on every read.
 */
const BATCH_ORDER: Prisma.DocumentOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
]

/**
 * The documents of one batch, oldest first.
 *
 * Order matters here in a way it does not on the documents page: a batch is
 * reviewed as a sequence, and "next document" has to mean the same thing every
 * time it is asked. Ownership is checked by the caller, against the batch.
 */
export async function listBatchDocuments(
  batchId: string,
  now = new Date()
): Promise<DocumentListItem[]> {
  // Every document, not the first fifty. The ceiling above is for a session's
  // own list; a batch is already bounded by the batch cap and the mailbox
  // limits, and a mailbox of nine hundred messages is a batch of nine hundred
  // and one. Capped here, the export planned from this list quietly covered
  // the first fifty messages and the rest were never exported at all.
  return query(inBatch(batchId, now), BATCH_ORDER, null)
}

/**
 * The ids of one batch's documents, in `listBatchDocuments` order.
 *
 * For the workspace, which asks on every page it renders where the open
 * document sits in its batch: previous, next, and "12 of 900". That needs the
 * order and nothing else, and reading every document's redactions to answer
 * it made reviewing a large mailbox quadratic.
 */
export async function listBatchDocumentIds(
  batchId: string,
  now = new Date()
): Promise<string[]> {
  const documents = await prisma.document.findMany({
    where: inBatch(batchId, now),
    orderBy: BATCH_ORDER,
    select: { id: true },
  })
  return documents.map((document) => document.id)
}

async function query(
  where: Prisma.DocumentWhereInput,
  orderBy: Prisma.DocumentOrderByWithRelationInput[],
  limit: number | null = LIST_LIMIT
): Promise<DocumentListItem[]> {
  const documents = await prisma.document.findMany({
    where,
    orderBy,
    ...(limit === null ? {} : { take: limit }),
    select: {
      id: true,
      originalName: true,
      kind: true,
      mimeType: true,
      size: true,
      status: true,
      pageCount: true,
      createdAt: true,
      expiresAt: true,
      error: true,
      errorCode: true,
      processedBlobKey: true,
      batchId: true,
    },
  })

  const countsById = await redactionCounts(
    documents.map((document) => document.id)
  )

  return documents.map((document) => {
    const counts = countsById.get(document.id) ?? {
      total: 0,
      suggested: 0,
      accepted: 0,
    }

    return {
      id: document.id,
      originalName: document.originalName,
      kind: document.kind as DocumentKind,
      mimeType: document.mimeType,
      size: document.size,
      status: document.status,
      pageCount: document.pageCount,
      createdAt: document.createdAt.toISOString(),
      expiresAt: document.expiresAt.toISOString(),
      error: document.error,
      errorCode: document.errorCode,
      hasExport: Boolean(document.processedBlobKey),
      batchId: document.batchId,
      counts,
    }
  })
}

/**
 * Redactions per document, counted by the database rather than read out a row
 * at a time: a reviewed mailbox is thousands of redactions, and this list
 * only ever shows how many.
 */
async function redactionCounts(
  ids: string[]
): Promise<Map<string, DocumentListItem["counts"]>> {
  const counts = new Map<string, DocumentListItem["counts"]>()

  for (let start = 0; start < ids.length; start += IN_LIST_LIMIT) {
    const rows = await prisma.redaction.groupBy({
      by: ["documentId", "status"],
      where: { documentId: { in: ids.slice(start, start + IN_LIST_LIMIT) } },
      _count: { _all: true },
    })

    for (const row of rows) {
      let entry = counts.get(row.documentId)
      if (!entry) {
        entry = { total: 0, suggested: 0, accepted: 0 }
        counts.set(row.documentId, entry)
      }
      const count = row._count._all
      entry.total += count
      if (row.status === "suggested") entry.suggested += count
      else if (row.status === "accepted") entry.accepted += count
    }
  }

  return counts
}
