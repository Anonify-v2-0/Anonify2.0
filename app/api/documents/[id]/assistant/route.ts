import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
} from "@/lib/api/http"
import { HushError, askHush, improveWithHush } from "@/lib/assistant/hush"
import {
  patternErrorResponse,
  patternSpecSchema,
  requireRuleContext,
} from "@/lib/redaction/pattern-api"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/**
 * Everything the model may be sent is named in this schema, with a length on
 * it. The panel builds the same object it shows the reviewer under "Hush will
 * send", so the list they read and the request that leaves are one value.
 */
const sample = z.object({
  before: z.string().max(200),
  match: z.string().min(1).max(500),
  after: z.string().max(200),
})

const askSchema = z.object({
  mode: z.literal("ask"),
  question: z.string().trim().min(1).max(1000),
  selection: z
    .object({
      text: z.string().min(1).max(500),
      category: z.string().max(60).optional(),
      source: z.string().max(20).optional(),
      reason: z.string().max(300).optional(),
      before: z.string().max(200).optional(),
      after: z.string().max(200).optional(),
    })
    .optional(),
  matches: z
    .object({
      query: z.string().min(1).max(500),
      samples: z.array(sample).max(20),
    })
    .optional(),
})

const improveSchema = z.object({
  mode: z.literal("improve"),
  spec: patternSpecSchema,
  accepted: z.array(z.string().min(1).max(500)).max(30),
  rejected: z.array(z.string().min(1).max(500)).max(30),
})

const bodySchema = z.discriminatedUnion("mode", [askSchema, improveSchema])

/**
 * Asks Hush about this document.
 *
 * `ask` answers a plain-language request with proposals, each previewed
 * against the document; `improve` tightens a RegEx rule and shows the matches
 * it would gain and lose. Neither changes anything: a proposal becomes a rule
 * only through the ordinary rules route, when the reviewer accepts it.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/assistant">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("processing", identity?.networkKey ?? "anonymous")

    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse("Invalid request", 400)

    const ruleContext = await requireRuleContext(id, identity?.ownerKey)
    if (ruleContext instanceof Response) return ruleContext
    const { document, target, batchId } = ruleContext

    if (parsed.data.mode === "improve") {
      const { spec, accepted, rejected } = parsed.data
      if (spec.kind !== "regex") {
        return errorResponse("Only RegEx rules can be improved", 400)
      }
      return jsonResponse(
        await improveWithHush({
          documentId: document.id,
          target,
          spec,
          accepted,
          rejected,
        })
      )
    }

    const { question, selection, matches } = parsed.data
    return jsonResponse(
      await askHush({
        documentId: document.id,
        target,
        context: { question, selection, matches, inBatch: Boolean(batchId) },
      })
    )
  } catch (error) {
    if (error instanceof HushError) {
      return errorResponse(error.message, 503, { code: error.reason })
    }
    return (
      patternErrorResponse(error) ?? handleRouteError(error, "assistant.ask")
    )
  }
}
