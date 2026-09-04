import { prisma } from "@/lib/database/prisma"
import {
  effectiveLimits,
  type RateLimitName,
} from "@/lib/security/rate-limit-config"
import {
  bucketFor,
  consume,
  freshState,
  refill,
  type BucketState,
} from "@/lib/security/token-bucket"

/**
 * Server-side rate limiting. Client-side throttling is decoration; this is the
 * control that actually holds.
 *
 * State is a token bucket per key, stored in Postgres so it is shared across
 * serverless instances. Read-modify-write is done inside a transaction: two
 * concurrent requests for the same key must not both read the same balance and
 * both decide they can spend it.
 */

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  /** When a refused caller could next succeed. */
  resetAt: Date
}

export async function consumeRateLimit(
  name: RateLimitName,
  identifier: string
): Promise<RateLimitResult> {
  const { limits } = await effectiveLimits()
  const { limit, windowSeconds } = limits[name]
  const config = bucketFor(limit, windowSeconds)
  const key = `${name}:${identifier}`
  const now = new Date()

  const decision = await prisma.$transaction(async (tx) => {
    const existing = await tx.rateLimit.findUnique({ where: { key } })

    const state: BucketState = existing
      ? { tokens: existing.tokens, updatedAt: existing.updatedAt }
      : freshState(config, now)

    const result = consume(state, config, now)

    // The state is written even when the request is refused, so the refill
    // clock keeps advancing and a refused caller is not penalised twice.
    await tx.rateLimit.upsert({
      where: { key },
      create: {
        key,
        tokens: result.state.tokens,
        updatedAt: result.state.updatedAt,
      },
      update: {
        tokens: result.state.tokens,
        updatedAt: result.state.updatedAt,
      },
    })

    return result
  })

  return {
    allowed: decision.allowed,
    remaining: decision.remaining,
    resetAt: new Date(now.getTime() + decision.retryAfterMs),
  }
}

/**
 * The state of a bucket without spending from it.
 *
 * Reading has to be free, or the panel that reports how much allowance is left
 * would consume the allowance it is reporting on — and refresh it away.
 */
export async function peekRateLimit(
  name: RateLimitName,
  identifier: string
): Promise<RateLimitResult & { limit: number; windowSeconds: number }> {
  const { limits } = await effectiveLimits()
  const { limit, windowSeconds } = limits[name]
  const config = bucketFor(limit, windowSeconds)
  const now = new Date()

  const existing = await prisma.rateLimit.findUnique({
    where: { key: `${name}:${identifier}` },
  })

  const state: BucketState = existing
    ? { tokens: existing.tokens, updatedAt: existing.updatedAt }
    : freshState(config, now)

  // `refill` rather than `consume`: the balance a caller has right now, not the
  // one they would have after spending a token they have not spent.
  const available = refill(state, config, now)
  const shortfall = Math.max(0, 1 - available)

  return {
    allowed: available >= 1,
    remaining: Math.floor(available),
    resetAt: new Date(
      now.getTime() + Math.ceil((shortfall / config.refillPerSecond) * 1000)
    ),
    limit,
    windowSeconds,
  }
}

/**
 * Drops buckets that have been idle long enough to have refilled completely —
 * an absent row and a full bucket mean the same thing.
 */
export async function pruneRateLimits(olderThanMinutes = 60): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000)
  const result = await prisma.rateLimit.deleteMany({
    where: { updatedAt: { lt: cutoff } },
  })
  return result.count
}
