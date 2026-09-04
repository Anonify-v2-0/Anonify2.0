import { prisma } from "@/lib/database/prisma"

/**
 * Reading back what analysis actually cost.
 *
 * Tokens, duration and call counts are measured facts, so they are always
 * reported. Money is not: prices change, they differ per account, and a
 * hardcoded table in an open-source repo is stale within weeks and quietly
 * wrong forever after. Rates come from the environment, and where none are
 * configured the cost is simply absent rather than invented.
 */

export type ModelRates = {
  /** USD per million input tokens. */
  inputPerMillion: number
  /** USD per million output tokens. */
  outputPerMillion: number
}

export function configuredRates(): ModelRates | null {
  const input = Number(process.env.AI_PRICE_INPUT_PER_MTOK)
  const output = Number(process.env.AI_PRICE_OUTPUT_PER_MTOK)

  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  if (input < 0 || output < 0) return null

  return { inputPerMillion: input, outputPerMillion: output }
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

const EMPTY: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 0,
  chunks: 0,
}

function add(totals: UsageTotals, row: Omit<UsageTotals, "calls">): UsageTotals {
  return {
    calls: totals.calls + 1,
    inputTokens: totals.inputTokens + row.inputTokens,
    outputTokens: totals.outputTokens + row.outputTokens,
    durationMs: totals.durationMs + row.durationMs,
    chunks: totals.chunks + row.chunks,
  }
}

export async function documentUsage(documentId: string): Promise<DocumentUsage> {
  const rows = await prisma.aiUsage.findMany({
    where: { documentId },
    orderBy: { createdAt: "asc" },
  })

  let totals = { ...EMPTY }
  const tasks = new Map<string, UsageTotals>()
  const models = new Set<string>()

  for (const row of rows) {
    totals = add(totals, row)
    models.add(row.model)
    tasks.set(row.task, add(tasks.get(row.task) ?? { ...EMPTY }, row))
  }

  return {
    documentId,
    totals,
    byTask: [...tasks.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.inputTokens - a.inputTokens),
    models: [...models],
    estimatedCostUsd: estimateCost(totals, configuredRates()),
  }
}

export type AggregateUsage = {
  documents: number
  totals: UsageTotals
  byModel: UsageBreakdown[]
  estimatedCostUsd: number | null
}

/**
 * Usage across the caller's own documents. Scoped by owner key, like every
 * other read — one session cannot see another's spend.
 */
export async function aggregateUsage(
  ownerKey: string | undefined
): Promise<AggregateUsage> {
  if (!ownerKey) {
    return { documents: 0, totals: { ...EMPTY }, byModel: [], estimatedCostUsd: null }
  }

  const documents = await prisma.document.findMany({
    where: { userFingerprint: ownerKey },
    select: { id: true },
  })

  if (documents.length === 0) {
    return { documents: 0, totals: { ...EMPTY }, byModel: [], estimatedCostUsd: null }
  }

  const rows = await prisma.aiUsage.findMany({
    where: { documentId: { in: documents.map((document) => document.id) } },
  })

  let totals = { ...EMPTY }
  const models = new Map<string, UsageTotals>()
  const seen = new Set<string>()

  for (const row of rows) {
    totals = add(totals, row)
    seen.add(row.documentId)
    models.set(row.model, add(models.get(row.model) ?? { ...EMPTY }, row))
  }

  return {
    documents: seen.size,
    totals,
    byModel: [...models.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.inputTokens - a.inputTokens),
    estimatedCostUsd: estimateCost(totals, configuredRates()),
  }
}

/** Compact "1.2k" / "3.4M" for token counts. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(2)}M`
}
