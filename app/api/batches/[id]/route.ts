import { handleRouteError, jsonResponse } from "@/lib/api/http"
import { batchOverview, requireBatch } from "@/lib/documents/batches"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/**
 * One batch: its documents and the decisions being carried across them.
 *
 * The batch view polls this while anything is still processing, which is also
 * how a document that finishes later shows the rules it inherited on arrival.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/batches/[id]">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const batch = await requireBatch(id, identity?.ownerKey)
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")

    return jsonResponse({ batch: await batchOverview(batch) })
  } catch (error) {
    return handleRouteError(error, "batches.read")
  }
}
