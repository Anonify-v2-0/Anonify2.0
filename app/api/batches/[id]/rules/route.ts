import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { requireBatch } from "@/lib/documents/batches"
import { removeBatchRule } from "@/lib/redaction/rules"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/**
 * Withdraws a decision from the whole batch.
 *
 * A carried decision that cannot be taken back would be worse than one that is
 * never carried: the reviewer would have to undo it document by document, in
 * files they may not have opened. This removes the rule and every redaction it
 * produced, everywhere it reached.
 *
 * Batch rules are created through the document they were decided in —
 * `POST /api/documents/[id]/rules` with `scope: "batch"` — because a decision
 * comes from looking at something.
 */
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/batches/[id]/rules">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const batch = await requireBatch(id, identity?.ownerKey)
    await consumeRateLimit("processing", identity?.networkKey ?? "anonymous")

    const ruleId = new URL(request.url).searchParams.get("ruleId")
    if (!ruleId) return errorResponse("No rule specified", 400)

    return jsonResponse(await removeBatchRule(batch.id, ruleId))
  } catch (error) {
    return handleRouteError(error, "batches.rules.delete")
  }
}
