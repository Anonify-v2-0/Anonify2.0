import { prisma } from "@/lib/database/prisma"
import {
  EMPTY_TOTALS,
  type AggregateUsage,
  type DocumentUsage,
  type UsageDegradation,
  type UsageTotals,
} from "@/lib/ai/usage-types"
import { estimateRows } from "@/lib/ai/rates"
export { configuredRates } from "@/lib/ai/rates"

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

function add(
  totals: UsageTotals,
  row: Omit<UsageTotals, "calls">
): UsageTotals {
  return {
    calls: totals.calls + 1,
    inputTokens: totals.inputTokens + row.inputTokens,
    outputTokens: totals.outputTokens + row.outputTokens,
    durationMs: totals.durationMs + row.durationMs,
    chunks: totals.chunks + row.chunks,
  }
}

/**
 * Whether the model pass fell short on this document, from the event the run
 * wrote when it did.
 *
 * Read from `processingEvent` rather than stored on the document because it is
 * a fact about one *run*. A document that failed on a rate limit and was
 * retried into a clean pass must not still be reported as degraded, so the
 * search is bounded to the newest run — everything after the last
 * `document.queued`. Without that bound the old event outlives the condition it
 * described, which is its own kind of lying to the reviewer.
 */
export async function documentDegradation(
  documentId: string
): Promise<UsageDegradation | null> {
  const started = await prisma.processingEvent.findFirst({
    where: { documentId, type: "document.queued" },
    orderBy: { at: "desc" },
    select: { at: true },
  })

  const event = await prisma.processingEvent.findFirst({
    where: {
      documentId,
      type: "document.ai.degraded",
      ...(started ? { at: { gte: started.at } } : {}),
    },
    orderBy: { at: "desc" },
  })

  if (!event) return null

  const payload = (event.payload ?? {}) as { reason?: unknown; calls?: unknown }
  const reason =
    typeof payload.reason === "string" ? payload.reason : "provider"
  const calls = typeof payload.calls === "number" ? payload.calls : 0

  return { reason, calls }
}

export async function documentUsage(
  documentId: string
): Promise<DocumentUsage> {
  const [rows, degraded] = await Promise.all([
    prisma.aiUsage.findMany({
      where: { documentId },
      orderBy: { createdAt: "asc" },
    }),
    documentDegradation(documentId),
  ])

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
    estimatedCostUsd: estimateRows(rows),
    degraded,
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
    models.set(
      row.model,
      add(models.get(row.model) ?? { ...EMPTY_TOTALS }, row)
    )
  }

  return {
    documents: seen.size,
    totals,
    byModel: [...models.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.inputTokens - a.inputTokens),
    estimatedCostUsd: estimateRows(rows),
  }
}
