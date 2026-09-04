import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { loadNormalized } from "@/lib/documents/normalized-store"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/** Returns the normalized model the canvas and inspector render from. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/documents/[id]/content">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")

    const document = await requireDocument(id, identity?.ownerKey)

    const record = await prisma.document.findUnique({
      where: { id: document.id },
      select: { normalizedBlobKey: true },
    })

    if (!record?.normalizedBlobKey) {
      return errorResponse("Document is not normalized yet", 409)
    }

    const model = await loadNormalized(
      record.normalizedBlobKey,
      document.encryptionKey
    )

    return jsonResponse(model)
  } catch (error) {
    return handleRouteError(error, "documents.content")
  }
}
