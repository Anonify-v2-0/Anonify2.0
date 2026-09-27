import { aiConfigured, recordUsage, resolveModel } from "@/lib/ai/gateway"
import { selectedProvider } from "@/lib/ai/providers"
import {
  configuredCapabilities,
  isLocalProvider,
  modelId,
} from "@/lib/ai/providers/config"
import { spendAllows, spendStatus } from "@/lib/ai/spend"
import { checkQuota, recordUsage as chargeUsage } from "@/lib/security/usage"

/**
 * Whether Hush can run on this instance, and the accounting for when it does.
 *
 * Hush uses the configured analysis provider, so it is subject to what bounds
 * analysis: the daily spend cap stops it, and every model step is recorded in
 * `AiUsage` against the document it was about. It also has an allowance of its
 * own per visitor, `assistantTokens`, charged step by step from the tokens the
 * provider reports — without one, a single visitor could spend the instance's
 * whole cap in a few minutes and stop analysis for everybody else. The agent
 * itself is in agent.ts; its tools are in tools.ts.
 */

export type HushUnavailable = "not-configured" | "unsupported" | "budget"

/**
 * How the instance reaches its model, for the badges in Hush's header.
 *
 * `kind` is what a reviewer cares about: a hosted API is billed per call and
 * sees the text sent to it; a local server keeps everything on the machine; a
 * subscription runs on somebody's ChatGPT plan; a gateway routes to whichever
 * vendor it was pointed at.
 */
export type HushProvider = {
  id: string
  label: string
  kind: "cloud" | "local" | "subscription" | "gateway"
  model: string
}

export type HushStatus =
  | { available: true; model: string; provider: HushProvider }
  | { available: false; reason: HushUnavailable; provider?: HushProvider }

export function hushProvider(): HushProvider | undefined {
  try {
    const provider = selectedProvider()
    return {
      id: provider.id,
      // The registry's labels are written for setup, where they say how to
      // sign in; the header only needs the name.
      label: provider.label.replace(/\s*\(.*\)\s*$/, ""),
      kind: provider.login
        ? "subscription"
        : provider.id === "gateway"
          ? "gateway"
          : isLocalProvider(provider.id)
            ? "local"
            : "cloud",
      model: modelId(),
    }
  } catch {
    return undefined
  }
}

export async function hushStatus(): Promise<HushStatus> {
  if (!aiConfigured()) return { available: false, reason: "not-configured" }
  const provider = hushProvider()
  // Tool calling is not probed separately; a model verified for structured
  // output is the same capability in every provider this codebase supports.
  if (!configuredCapabilities().structuredOutput) {
    return { available: false, reason: "unsupported", provider }
  }
  if (!spendAllows(await spendStatus())) {
    return { available: false, reason: "budget", provider }
  }
  if (!provider) return { available: false, reason: "not-configured" }
  return { available: true, model: resolveModel(), provider }
}

export const HUSH_UNAVAILABLE_MESSAGES: Record<HushUnavailable, string> = {
  "not-configured":
    "Hush needs an AI provider, and this instance has none configured.",
  unsupported:
    "The configured model cannot call tools reliably, which Hush needs. An administrator can choose another with `pnpm ai`.",
  budget:
    "This instance has reached its daily AI spend cap. Hush is back tomorrow (UTC).",
}

export const HUSH_ALLOWANCE_MESSAGE =
  "You have used today's Hush allowance. It resets at midnight UTC; search, rules and redacting by hand keep working."

/** Whether this visitor may ask Hush's model anything more today. */
export async function hushAllowanceLeft(quotaKey: string): Promise<boolean> {
  return (await checkQuota(quotaKey, "assistantTokens")).allowed
}

/**
 * Ends a run between steps. Its message is one of the fixed sentences above,
 * so the route can hand it to the panel as it is.
 */
export class HushStopped extends Error {
  constructor(readonly code: "budget" | "allowance") {
    super(
      code === "budget"
        ? HUSH_UNAVAILABLE_MESSAGES.budget
        : HUSH_ALLOWANCE_MESSAGE
    )
    this.name = "HushStopped"
  }
}

/**
 * Checked before every step after the first, once the one before it has been
 * charged. A run is up to twelve steps, each resending the conversation, so a
 * check made only when the run started is a check on the first step alone.
 */
export async function assertHushMayContinue(quotaKey: string): Promise<void> {
  if (!spendAllows(await spendStatus())) throw new HushStopped("budget")
  if (!(await hushAllowanceLeft(quotaKey))) throw new HushStopped("allowance")
}

/**
 * One model step of a Hush run: a usage row against the document, and its
 * tokens charged to the visitor's allowance. Never its content.
 */
export async function recordHushStep(input: {
  documentId: string
  quotaKey: string
  inputTokens?: number
  outputTokens?: number
  durationMs: number
}): Promise<void> {
  const inputTokens = input.inputTokens ?? 0
  const outputTokens = input.outputTokens ?? 0
  await recordUsage({
    documentId: input.documentId,
    task: "assistant",
    model: resolveModel(),
    inputTokens,
    outputTokens,
    durationMs: input.durationMs,
  })
  if (inputTokens + outputTokens > 0) {
    await chargeUsage({
      fingerprint: input.quotaKey,
      kind: "assistantTokens",
      quantity: inputTokens + outputTokens,
    })
  }
}
