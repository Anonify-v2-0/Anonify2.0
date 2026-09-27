import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
} from "@/lib/api/http"
import { requireBatch } from "@/lib/documents/batches"
import {
  categorySchema,
  patternErrorResponse,
  patternSpecSchema,
} from "@/lib/redaction/pattern-api"
import { removeBatchRule, updateBatchRule } from "@/lib/redaction/rules"
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

const updateSchema = z.object({
  ruleId: z.string().min(1),
  enabled: z.boolean().optional(),
  spec: patternSpecSchema.optional(),
  category: categorySchema.optional(),
})

/**
 * Switches a batch decision off or on, or rewrites it, in every document it
 * reaches. Switched off, the rule stays listed and its redactions go; on
 * again, it is re-applied everywhere in one transaction or not at all.
 */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/batches/[id]/rules">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const batch = await requireBatch(id, identity?.ownerKey)
    await consumeRateLimit("processing", identity?.networkKey ?? "anonymous")

    const parsed = updateSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse("Invalid rule change", 400)

    const { ruleId, ...changes } = parsed.data
    const result = await updateBatchRule({
      batchId: batch.id,
      batchRuleId: ruleId,
      ...changes,
    })
    if (!result) return errorResponse("Rule not found", 404)

    return jsonResponse(result)
  } catch (error) {
    return patternErrorResponse(error) ?? handleRouteError(error, "batches.rules.update")
  }
}
