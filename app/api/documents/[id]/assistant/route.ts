import { createAgentUIStreamResponse } from "ai"
import { z } from "zod"

import { errorResponse, handleRouteError, readJsonWithin } from "@/lib/api/http"
import { buildHushAgent } from "@/lib/assistant/agent"
import {
  assertHushMayContinue,
  HUSH_ALLOWANCE_MESSAGE,
  HUSH_UNAVAILABLE_MESSAGES,
  hushAllowanceLeft,
  HushStopped,
  hushStatus,
  recordHushStep,
} from "@/lib/assistant/hush"
import { SubscriptionAuthError } from "@/lib/ai/providers/subscription"
import { requireRuleContext } from "@/lib/redaction/pattern-api"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"
/** An agent run reads, searches and waits on a model several times over. */
export const maxDuration = 300

/**
 * A conversation turn is bounded here rather than trusted: the history is
 * client-held, so its size is capped, and every approval in it is verified
 * against this server's signature before a tool runs (see agent.ts).
 */
const bodySchema = z.object({
  messages: z.array(z.record(z.string(), z.unknown())).min(1).max(80),
  readConsent: z.boolean().default(false),
  view: z
    .object({
      currentPage: z.number().int().positive().optional(),
      selected: z
        .object({
          id: z.string().max(64),
          text: z.string().max(500).optional(),
          category: z.string().max(60),
          status: z.string().max(20),
          source: z.string().max(20),
          page: z.number().int().positive().optional(),
          reason: z.string().max(300).optional(),
        })
        .optional(),
    })
    .default({}),
})

/**
 * The largest conversation a request may carry, in bytes: counted as the body
 * arrives, not taken from what the request declares.
 */
const MAX_BODY_BYTES = 1_500_000

/**
 * Talks to Hush about this document, as a streamed agent run.
 *
 * The run reads and searches the document through tools, and stops at every
 * change for the reviewer's approval; the panel continues the run with their
 * answer. Nothing is written by this route except through a tool the reviewer
 * approved.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/assistant">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("processing", identity?.networkKey ?? "anonymous")

    const body = await readJsonWithin(request, MAX_BODY_BYTES)
    if (body.tooLarge) {
      return errorResponse("This conversation is too long. Start a new one.", 413)
    }

    const parsed = bodySchema.safeParse(body.value)
    if (!parsed.success) return errorResponse("Invalid request", 400)

    const ruleContext = await requireRuleContext(id, identity?.ownerKey)
    if (ruleContext instanceof Response) return ruleContext
    const { document, target, batchId } = ruleContext
    // requireRuleContext has already refused a request with no session.
    const quotaKey = identity?.quotaKey
    if (!quotaKey) return errorResponse("No session", 401)

    const status = await hushStatus()
    if (!status.available) {
      return errorResponse(HUSH_UNAVAILABLE_MESSAGES[status.reason], 503, {
        code: status.reason,
      })
    }

    // Charged to the visitor rather than the document: the same allowance
    // whichever document they ask about. Checked again between steps.
    if (!(await hushAllowanceLeft(quotaKey))) {
      return errorResponse(HUSH_ALLOWANCE_MESSAGE, 429, { code: "allowance" })
    }

    const agent = await buildHushAgent({
      context: {
        documentId: document.id,
        target,
        batchId,
        ownerKey: document.userFingerprint,
        name: document.originalName,
        kind: document.kind,
      },
      view: parsed.data.view,
      readConsent: parsed.data.readConsent,
      beforeStep: () => assertHushMayContinue(quotaKey),
    })

    let stepStarted = Date.now()

    return createAgentUIStreamResponse({
      agent,
      uiMessages: parsed.data.messages,
      abortSignal: request.signal,
      onStepEnd: async (step) => {
        const now = Date.now()
        await recordHushStep({
          documentId: document.id,
          quotaKey,
          inputTokens: step.usage.inputTokens,
          outputTokens: step.usage.outputTokens,
          durationMs: now - stepStarted,
        })
        stepStarted = now
      },
      // Never the raw error: a provider message can quote the prompt, and the
      // prompt holds document text. A run stopped between steps is the one
      // exception, because its message is a fixed sentence of ours.
      onError: (error) => {
        if (error instanceof HushStopped) return error.message
        console.error(
          JSON.stringify({
            level: "error",
            context: "assistant.run",
            documentId: document.id,
            errorName: error instanceof Error ? error.name : "unknown",
          })
        )
        return "Hush hit a problem talking to the AI provider. Try again."
      },
    })
  } catch (error) {
    // The ChatGPT sign-in lives in the database; missing or expired, the model
    // cannot be built at all. Say what fixes it rather than "something went
    // wrong".
    if (error instanceof SubscriptionAuthError) {
      return errorResponse(error.message, 503, { code: "authorization" })
    }
    return handleRouteError(error, "assistant.run")
  }
}
