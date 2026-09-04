import { handleRouteError, jsonResponse } from "@/lib/api/http"
import { documentUsage } from "@/lib/ai/usage-report"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"

export const runtime = "nodejs"

/** What analysis cost for one document: tokens, duration, calls, by task. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/documents/[id]/usage">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)

    return jsonResponse(await documentUsage(document.id))
  } catch (error) {
    return handleRouteError(error, "documents.usage")
  }
}
