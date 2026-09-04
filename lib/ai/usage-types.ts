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

export type DocumentUsage = {
  documentId: string
  totals: UsageTotals
  byTask: UsageBreakdown[]
  models: string[]
  /** Null when no rates are configured. */
  estimatedCostUsd: number | null
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
