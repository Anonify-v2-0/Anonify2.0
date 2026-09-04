import { prisma } from "@/lib/database/prisma"
import {
  EMPTY_TOTALS,
  estimateCost,
  type AggregateUsage,
  type DocumentUsage,
  type ModelRates,
  type UsageTotals,
} from "@/lib/ai/usage-types"

/**
 * Reading back what analysis actually cost.
 *
 * Tokens, duration and call counts are measured facts, so they are always
 * reported. Money is not: prices change, they differ per account, and a
 * hardcoded table in an open-source repo is stale within weeks and quietly
 * wrong forever after. Rates come from the environment, and where none are
 * configured the cost is simply absent rather than invented.
 *
 * This module talks to the database; the shapes and formatters live in
 * usage-types.ts so client components can use them without pulling Prisma into
 * the browser bundle.
 */

export function configuredRates(): ModelRates | null {
  const input = Number(process.env.AI_PRICE_INPUT_PER_MTOK)
  const output = Number(process.env.AI_PRICE_OUTPUT_PER_MTOK)

  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  if (input < 0 || output < 0) return null

  return { inputPerMillion: input, outputPerMillion: output }
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

  let totals = { ...EMPTY_TOTALS }
  const tasks = new Map<string, UsageTotals>()
  const models = new Set<string>()

  for (const row of rows) {
    totals = add(totals, row)
    models.add(row.model)
    tasks.set(row.task, add(tasks.get(row.task) ?? { ...EMPTY_TOTALS }, row))
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

/**
 * Usage across the caller's own documents. Scoped by owner key, like every
 * other read — one session cannot see another's spend.
 */
export async function aggregateUsage(
  ownerKey: string | undefined
): Promise<AggregateUsage> {
  const empty: AggregateUsage = {
    documents: 0,
    totals: { ...EMPTY_TOTALS },
    byModel: [],
    estimatedCostUsd: null,
  }

  if (!ownerKey) return empty

  const documents = await prisma.document.findMany({
    where: { userFingerprint: ownerKey },
    select: { id: true },
  })

  if (documents.length === 0) return empty

  const rows = await prisma.aiUsage.findMany({
    where: { documentId: { in: documents.map((document) => document.id) } },
  })

  let totals = { ...EMPTY_TOTALS }
  const models = new Map<string, UsageTotals>()
  const seen = new Set<string>()

  for (const row of rows) {
    totals = add(totals, row)
    seen.add(row.documentId)
    models.set(row.model, add(models.get(row.model) ?? { ...EMPTY_TOTALS }, row))
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
