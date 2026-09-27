import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { readNormalized } from "@/lib/documents/normalized-store"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/**
 * Returns the normalized model the canvas and inspector render from.
 *
 * - `?view=outline` — everything but the pages, and which pages exist. What
 *   the editor opens first.
 * - `?page=N` — one page. For a model written with an index this is a ranged
 *   read of the chunks that cover that page and nothing else.
 * - no query — the whole model, as it has always been served.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/documents/[id]/content">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")

    const document = await requireDocument(id, identity?.ownerKey)

    const record = await prisma.document.findUnique({
      where: { id: document.id },
      select: { normalizedBlobKey: true, normalizedIndex: true },
    })

    if (!record?.normalizedBlobKey || !document.encryptionKey) {
      return errorResponse("Document is not normalized yet", 409)
    }

    const reader = readNormalized({
      id: document.id,
      encryptionKey: document.encryptionKey,
      encryptionFormat: document.encryptionFormat,
      normalizedBlobKey: record.normalizedBlobKey,
      normalizedIndex: record.normalizedIndex,
    })

    const params = new URL(request.url).searchParams

    if (params.get("view") === "outline") {
      return jsonResponse(await reader.outline())
    }

    const requested = params.get("page")
    if (requested !== null) {
      const number = /^\d{1,7}$/.test(requested) ? Number(requested) : NaN
      if (!Number.isInteger(number) || number < 1) {
        return errorResponse("Invalid page", 400)
      }
      const page = await reader.page(number)
      return page ? jsonResponse(page) : errorResponse("No such page", 404)
    }

    return jsonResponse(await reader.whole())
  } catch (error) {
    return handleRouteError(error, "documents.content")
  }
}
