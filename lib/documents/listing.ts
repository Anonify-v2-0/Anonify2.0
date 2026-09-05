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
  counts: {
    total: number
    suggested: number
    accepted: number
  }
}

/** A generous ceiling; the anonymous demo quota keeps real lists far smaller. */
const LIST_LIMIT = 50

export async function listDocuments(
  ownerKey: string | undefined,
  now = new Date()
): Promise<DocumentListItem[]> {
  if (!ownerKey) return []

  const documents = await prisma.document.findMany({
    where: { userFingerprint: ownerKey, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
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
      redactions: { select: { status: true } },
    },
  })

  return documents.map((document) => {
    const counts = { total: 0, suggested: 0, accepted: 0 }
    for (const redaction of document.redactions) {
      counts.total += 1
      if (redaction.status === "suggested") counts.suggested += 1
      else if (redaction.status === "accepted") counts.accepted += 1
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
      counts,
    }
  })
}
