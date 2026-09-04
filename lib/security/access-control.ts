import { prisma } from "@/lib/database/prisma"

/**
 * Ownership checks. A document id alone never authorizes anything: every read,
 * mutation and download re-derives the caller's identity and compares it with
 * the owner recorded at upload time.
 */

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 404 | 410
  ) {
    super(message)
    this.name = "AccessError"
  }
}

export type OwnedDocument = {
  id: string
  originalName: string
  kind: string
  mimeType: string
  size: number
  status: string
  pageCount: number | null
  createdAt: Date
  expiresAt: Date
  sourceBlobKey: string
  processedBlobKey: string | null
  encryptionKey: string
  checksum: string
  error: string | null
  userFingerprint: string
}

export async function requireDocument(
  documentId: string,
  ownerKey: string | undefined
): Promise<OwnedDocument> {
  if (!ownerKey) {
    throw new AccessError("No session", 401)
  }

  const document = await prisma.document.findUnique({
    where: { id: documentId },
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
      sourceBlobKey: true,
      processedBlobKey: true,
      encryptionKey: true,
      checksum: true,
      error: true,
      userFingerprint: true,
    },
  })

  // A document that exists but belongs to somebody else is reported as missing:
  // ownership must not be probeable by id.
  if (!document || document.userFingerprint !== ownerKey) {
    throw new AccessError("Document not found", 404)
  }

  if (document.expiresAt.getTime() <= Date.now()) {
    throw new AccessError("Document has expired", 410)
  }

  return document
}
