import { z } from "zod"

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { purgeDocument, PURGE_SELECT } from "@/lib/documents/purge"
import {
  RETENTION_MESSAGES,
  resolveExtension,
  retentionCeiling,
} from "@/lib/documents/retention"
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

const extendSchema = z.object({
  ttlSeconds: z.number().int().positive(),
})

/**
 * Extends a document's retention window.
 *
 * The new expiry is computed from when the document was created, never from
 * now, so extending converges on the demo ceiling instead of walking it forward
 * indefinitely. See lib/documents/retention.ts.
 */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/documents/[id]">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const limit = await consumeRateLimit(
      "processing",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) {
      return errorResponse("Too many requests. Try again shortly.", 429)
    }

    const document = await requireDocument(id, identity?.ownerKey)

    const parsed = extendSchema.safeParse(await request.json())
    if (!parsed.success) {
      return errorResponse("Invalid retention window", 400)
    }

    const decision = resolveExtension({
      createdAt: document.createdAt,
      currentExpiresAt: document.expiresAt,
      requestedTtlSeconds: parsed.data.ttlSeconds,
    })

    if (!decision.ok) {
      return errorResponse(RETENTION_MESSAGES[decision.reason], 409, {
        ceiling: retentionCeiling(document.createdAt).toISOString(),
      })
    }

    await prisma.document.update({
      where: { id: document.id },
      data: {
        expiresAt: decision.expiresAt,
        ttlSeconds: decision.ttlSeconds,
        // A document the sweep had already marked can come back while its
        // storage is still there; the sweep deletes, it does not tombstone.
        status: document.status === "expired" ? "ready" : document.status,
      },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.extend",
        documentId: document.id,
        ttlSeconds: decision.ttlSeconds,
        capped: decision.capped,
      })
    )

    return jsonResponse({
      expiresAt: decision.expiresAt.toISOString(),
      ttlSeconds: decision.ttlSeconds,
      capped: decision.capped,
      ceiling: retentionCeiling(document.createdAt).toISOString(),
    })
  } catch (error) {
    return handleRouteError(error, "documents.extend")
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
