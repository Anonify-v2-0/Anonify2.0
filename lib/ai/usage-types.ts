/**
 * The shape of usage data, and the pure functions over it.
 *
 * Deliberately free of server imports. The summary components are client
 * components, and a type-only import is erased but a value import is not — one
 * `formatTokens` reaching into the module that talks to the database is enough
 * to drag Prisma, and `node:module` with it, into the browser bundle.
 */

export type ModelRates = {
  /** USD per million input tokens. */
  inputPerMillion: number
  /** USD per million output tokens. */
  outputPerMillion: number
}

export type UsageTotals = {
  calls: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  chunks: number
}

export type UsageBreakdown = UsageTotals & {
  /** The grouping key — a task name, or a model id. */
  key: string
}

/**
 * The model pass having done less than it meant to, and why.
 *
 * Reported alongside what the analysis cost because it is the other half of the
 * same question. "Six model calls, $0.004" and "six model calls, $0.004, and
 * eleven more the provider refused" describe very different documents, and only
 * one of them is safe to review as though the model had been asked.
 */
export type UsageDegradation = {
  reason: string
  /** Model calls lost to it. */
  calls: number
}

/** Plain language for a reason code, for the reviewer rather than the log. */
export const DEGRADATION_LABELS: Record<string, string> = {
  "rate-limit":
    "the AI provider was rate-limiting this instance and the wait did not clear",
  budget: "the configured daily AI spend cap was reached",
  authorization: "the AI provider rejected this instance's key",
  timeout: "the AI provider did not answer in time",
  "invalid-output": "the AI provider returned something unreadable",
  provider: "the AI provider failed",
  unsupported: "the selected model lacks verified structured-output or image support for this call; run setup to choose a compatible model",
}

export function describeDegradation(degraded: UsageDegradation): string {
  const cause = DEGRADATION_LABELS[degraded.reason] ?? "the AI provider failed"
  const calls =
    degraded.calls === 1 ? "1 model call" : `${degraded.calls} model calls`
  return degraded.calls > 0
    ? `${calls} did not happen because ${cause}. Pattern detection ran in full; the contextual pass did not.`
    : `The contextual pass was skipped because ${cause}. Pattern detection ran in full.`
}

export type DocumentUsage = {
  documentId: string
  totals: UsageTotals
  byTask: UsageBreakdown[]
  models: string[]
  /** Null when no rates are configured. */
  estimatedCostUsd: number | null
  /** Null when the model pass did everything it set out to. */
  degraded: UsageDegradation | null
}

export type AggregateUsage = {
  documents: number
  totals: UsageTotals
  byModel: UsageBreakdown[]
  estimatedCostUsd: number | null
}

export const EMPTY_TOTALS: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 0,
  chunks: 0,
}

export function estimateCost(
  totals: { inputTokens: number; outputTokens: number },
  rates: ModelRates | null
): number | null {
  if (!rates) return null
  return (
    (totals.inputTokens / 1_000_000) * rates.inputPerMillion +
    (totals.outputTokens / 1_000_000) * rates.outputPerMillion
  )
}

/** Compact "1.2k" / "3.4M" for token counts. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(2)}M`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

export function formatCost(usd: number | null): string | null {
  if (usd === null) return null
  if (usd === 0) return "$0.00"
  if (usd < 0.01) return "<$0.01"
  return `$${usd.toFixed(2)}`
}
