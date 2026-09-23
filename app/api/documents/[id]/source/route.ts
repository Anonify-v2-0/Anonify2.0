import { errorResponse, handleRouteError, streamResponse } from "@/lib/api/http"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { sourceKey } from "@/lib/storage/blob"
import { documentSeal, getSealedStream } from "@/lib/storage/sealed"

export const runtime = "nodejs"

/**
 * Streams the decrypted source so the browser can render the document at full
 * fidelity. Authorization happens here, per request — the underlying blob URL
 * is never handed out, and nothing is cached.
 *
 * Streamed end to end for a chunked document: plaintext leaves one
 * authenticated chunk at a time and the source is never whole in this
 * process. A legacy document is opened whole first, as it always was.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/documents/[id]/source">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")

    const document = await requireDocument(id, identity?.ownerKey)
    if (!document.sourceBlobKey || !document.encryptionKey) {
      return errorResponse("Document is still being ingested", 409)
    }

    const body = await getSealedStream(
      document.sourceBlobKey,
      sourceKey(document.id),
      documentSeal(document)
    )

    return streamResponse(body, {
      "content-type": document.mimeType,
      "cache-control": "no-store, private",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    })
  } catch (error) {
    return handleRouteError(error, "documents.source")
  }
}
