import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { purgeDocument, PURGE_SELECT } from "@/lib/documents/purge"
import { consumeRateLimit } from "@/lib/security/rate-limit"
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

    // Ownership is settled above; the purge below removes every artifact the
    // document owns, not just the source.
    const purgeable = await prisma.document.findUnique({
      where: { id: document.id },
      select: PURGE_SELECT,
    })
    if (!purgeable) return jsonResponse({ deleted: true })

    const result = await purgeDocument(purgeable)
    if (!result.recordDeleted) {
      return errorResponse("Some artifacts could not be deleted", 500)
    }

    return jsonResponse({ deleted: true })
  } catch (error) {
    return handleRouteError(error, "documents.delete")
  }
}
