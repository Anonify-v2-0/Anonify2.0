import { prisma } from "@/lib/database/prisma"
import { configuredRates } from "@/lib/ai/usage-report"
import { estimateCost } from "@/lib/ai/usage-types"
import {
  dailySpendCapUsd,
  SPEND_ENV_NAME,
  SPEND_SLOWDOWN_FRACTION,
} from "@/lib/services/limits"
import { setConcurrencyCeiling } from "@/lib/services/throttle"

/**
 * The gateway's real ceiling.
 *
 * The AI Gateway does not meter requests per minute; it meters *spend*. There
 * is a credit balance and a budget, and the way an install discovers it has
 * reached them is a 402 in the middle of somebody's document — a failure no
 * amount of retrying improves, because the correct response to being out of
 * money is to stop.
 *
 * So the cap that matters is one this application enforces on itself, before
 * the money is spent. It is computed from the `aiUsage` rows already written on
 * every call and the prices in `AI_PRICE_*`, which makes it an estimate rather
 * than a bill: prices change, they differ per account, and this codebase has
 * always refused to invent them (see lib/ai/usage-report.ts). That is exactly
 * why the cap is opt-in and unset by default — a budget nobody set should never
 * silently stop a redaction — and why an install with no configured prices
 * cannot have one at all.
 *
 * Two thresholds rather than one. A cap that only acts at 100% is a cliff, and
 * the document that walks off it is one halfway through review.
 */

export type SpendStatus =
  | { state: "uncapped"; reason: "no-cap" | "no-prices" }
  | { state: "under"; spentUsd: number; capUsd: number }
  /** Past the slowdown threshold: still running, one call at a time. */
  | { state: "slowing"; spentUsd: number; capUsd: number }
  /** At or over the cap: the contextual pass is skipped for the rest of the day. */
  | { state: "exhausted"; spentUsd: number; capUsd: number }

/** Midnight UTC, matching how daily quotas are counted (lib/security/usage.ts). */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
}

/**
 * What has been spent through the gateway since midnight UTC.
 *
 * Across every document and every owner, because that is the shape of the thing
 * being protected: one API key, one balance. The per-owner reads elsewhere are
 * scoped so nobody sees another person's usage; this one is never shown to
 * anyone, only compared against a number the operator set.
 */
export async function spentTodayUsd(now: Date = new Date()): Promise<number | null> {
  const rates = configuredRates()
  if (!rates) return null

  const totals = await prisma.aiUsage.aggregate({
    where: { createdAt: { gte: startOfUtcDay(now) } },
    _sum: { inputTokens: true, outputTokens: true },
  })

  return (
    estimateCost(
      {
        inputTokens: totals._sum.inputTokens ?? 0,
        outputTokens: totals._sum.outputTokens ?? 0,
      },
      rates
    ) ?? 0
  )
}

/**
 * Where today stands against the cap, with the gateway's concurrency ceiling
 * adjusted to match.
 *
 * Called before the contextual pass rather than before every chunk: a hundred
 * chunks is a hundred aggregate queries for a number that cannot move much
 * between them, and the retry path already handles the 402 if the estimate is
 * wrong in the direction that matters.
 */
export async function spendStatus(now: Date = new Date()): Promise<SpendStatus> {
  const capUsd = dailySpendCapUsd()

  if (capUsd <= 0) {
    setConcurrencyCeiling("ai", null)
    return { state: "uncapped", reason: "no-cap" }
  }

  const spentUsd = await spentTodayUsd(now)

  if (spentUsd === null) {
    // A cap with no prices behind it cannot be enforced, and pretending to
    // enforce it would stop work for a number that was never computed. Say so
    // where an operator will see it rather than failing quietly either way.
    console.warn(
      JSON.stringify({
        level: "warn",
        context: "ai.spend",
        message: `${SPEND_ENV_NAME} is set but AI_PRICE_INPUT_PER_MTOK and AI_PRICE_OUTPUT_PER_MTOK are not, so no spend can be estimated and the cap is not in force.`,
      })
    )
    setConcurrencyCeiling("ai", null)
    return { state: "uncapped", reason: "no-prices" }
  }

  if (spentUsd >= capUsd) {
    setConcurrencyCeiling("ai", 1)
    return { state: "exhausted", spentUsd, capUsd }
  }

  if (spentUsd >= capUsd * SPEND_SLOWDOWN_FRACTION) {
    setConcurrencyCeiling("ai", 1)
    return { state: "slowing", spentUsd, capUsd }
  }

  setConcurrencyCeiling("ai", null)
  return { state: "under", spentUsd, capUsd }
}

/** Whether the model may be asked anything at all right now. */
export function spendAllows(status: SpendStatus): boolean {
  return status.state !== "exhausted"
}
