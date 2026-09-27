import { aiConfigured, recordUsage, resolveModel } from "@/lib/ai/gateway"
import { selectedProvider } from "@/lib/ai/providers"
import {
  configuredCapabilities,
  isLocalProvider,
  modelId,
} from "@/lib/ai/providers/config"
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
