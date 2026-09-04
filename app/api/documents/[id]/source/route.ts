import { errorResponse, handleRouteError } from "@/lib/api/http"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { getObject } from "@/lib/storage/blob"
import { decryptDocument } from "@/lib/storage/encryption"

export const runtime = "nodejs"

/**
 * Streams the decrypted source so the browser can render the document at full
 * fidelity. Authorization happens here, per request — the underlying blob URL
 * is never handed out, and nothing is cached.
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

    const sealed = await getObject(document.sourceBlobKey)
    const bytes = decryptDocument(sealed, document.encryptionKey)

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": document.mimeType,
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store, private",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    })
  } catch (error) {
    return handleRouteError(error, "documents.source")
  }
}
