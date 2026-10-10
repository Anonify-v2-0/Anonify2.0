import { errorResponse, handleRouteError } from "@/lib/api/http"
import {
  findDocumentExport,
  takeVaultEnvelope,
} from "@/lib/documents/document-exports"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"

export const runtime = "nodejs"

/**
 * A variant's vault, sealed to the browser that asked for the export (#187).
 *
 * Handed over once: read, deleted, gone. It opens only with that browser's
 * private key (lib/redaction/vault-envelope.ts), so what is stored was never
 * something Anonify could read; deleting it on the way out means it is not
 * stored any longer than it has to be. A second request is a 410.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/documents/[id]/export/[exportId]/vault">
) {
  try {
    const { id, exportId } = await context.params
    const artifactId = new URL(request.url).searchParams.get("artifact")
    if (!artifactId) return errorResponse("Missing artifact", 400)

    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)
    const record = await findDocumentExport(document.id, exportId)
    if (!record) return errorResponse("Export not found", 404)

    const envelope = await takeVaultEnvelope(document, exportId, artifactId)
    if (!envelope) {
      return errorResponse(
        "This vault has already been collected, or there is none",
        410
      )
    }
    return new Response(envelope as BodyInit, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    })
  } catch (error) {
    return handleRouteError(error, "documents.export.vault")
  }
}
