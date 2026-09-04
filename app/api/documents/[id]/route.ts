import { handleRouteError, jsonResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { deleteObject } from "@/lib/storage/blob"
import type { DocumentKind, DocumentSummary } from "@/types/document"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  context: RouteContext<"/api/documents/[id]">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")

    const document = await requireDocument(id, identity?.ownerKey)

    const summary: DocumentSummary = {
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
    }

    return jsonResponse(summary)
  } catch (error) {
    return handleRouteError(error, "documents.get")
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/documents/[id]">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)

    for (const key of [document.sourceBlobKey, document.processedBlobKey]) {
      if (key) await deleteObject(key)
    }
    await prisma.document.delete({ where: { id: document.id } })

    return jsonResponse({ deleted: true })
  } catch (error) {
    return handleRouteError(error, "documents.delete")
  }
}
