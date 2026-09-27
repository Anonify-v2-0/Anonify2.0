import { aiConfigured, recordUsage, resolveModel } from "@/lib/ai/gateway"
import { configuredCapabilities } from "@/lib/ai/providers/config"
import { spendAllows, spendStatus } from "@/lib/ai/spend"

/**
 * Whether Hush can run on this instance, and the accounting for when it does.
 *
 * Hush uses the configured analysis provider, so it is subject to what bounds
 * analysis: the daily spend cap stops it, and every model step is recorded in
 * `AiUsage` against the document it was about. The agent itself is in
 * agent.ts; its tools are in tools.ts.
 */

export type HushUnavailable = "not-configured" | "unsupported" | "budget"

export type HushStatus =
  | { available: true; model: string }
  | { available: false; reason: HushUnavailable }

export async function hushStatus(): Promise<HushStatus> {
  if (!aiConfigured()) return { available: false, reason: "not-configured" }
  // Tool calling is not probed separately; a model verified for structured
  // output is the same capability in every provider this codebase supports.
  if (!configuredCapabilities().structuredOutput) {
    return { available: false, reason: "unsupported" }
  }
  if (!spendAllows(await spendStatus())) {
    return { available: false, reason: "budget" }
  }
  return { available: true, model: resolveModel() }
}

export const HUSH_UNAVAILABLE_MESSAGES: Record<HushUnavailable, string> = {
  "not-configured":
    "Hush needs an AI provider, and this instance has none configured.",
  unsupported:
    "The configured model cannot call tools reliably, which Hush needs. An administrator can choose another with `pnpm ai`.",
  budget:
    "This instance has reached its daily AI spend cap. Hush is back tomorrow (UTC).",
}

/** One model step of a Hush run, as a usage row. Never its content. */
export async function recordHushStep(input: {
  documentId: string
  inputTokens?: number
  outputTokens?: number
  durationMs: number
}): Promise<void> {
  await recordUsage({
    documentId: input.documentId,
    task: "assistant",
    model: resolveModel(),
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    durationMs: input.durationMs,
  })
}
