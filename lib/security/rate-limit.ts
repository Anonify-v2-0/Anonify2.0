import { prisma } from "@/lib/database/prisma"
import {
  effectiveLimits,
  type RateLimitName,
} from "@/lib/security/rate-limit-config"
import {
  bucketFor,
  freshState,
  refill,
  type BucketConfig,
  type BucketState,
} from "@/lib/security/token-bucket"

/**
 * Server-side rate limiting. Client-side throttling is decoration; this is the
 * control that actually holds.
 *
 * State is a token bucket per key, stored in Postgres so it is shared across
 * serverless instances. It runs on nearly every API request, and the network
 * keys are shared by everyone behind one address, so it is one statement and
 * one round trip (#171): two concurrent requests for the same key must not
 * both read the same balance and both decide they can spend it, and the row
 * lock the statement takes is what stops them.
 *
 * The maths is token-bucket.ts's, written in SQL; that file stays the
 * reference, and a test holds the two to the same answers.
 */

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  /** When a refused caller could next succeed. */
  resetAt: Date
}

/**
 * Spends one token, in one statement.
 *
 * The bucket is refilled for the time since it was last touched and spent
 * only if that leaves at least one token: `ON CONFLICT … DO UPDATE … WHERE`.
 * Postgres evaluates that condition against the row version it has locked,
 * so it is atomic, and a row comes back exactly when the request is allowed.
 * A key never seen before is inserted as a full bucket, less the token.
 *
 * A refused request writes nothing. That is the same as writing its refilled
 * balance, as the reference does: below the cap, refilling from the old
 * state at any later moment gives the same balance as refilling from one
 * written now. The second sub-select reads that balance, for when to retry.
 *
 * Time is passed as epoch seconds and turned into UTC in SQL, because
 * `updatedAt` is a timestamp without a zone, written as UTC, and comparing it
 * with a zoned parameter would shift it by the session's offset.
 */
export async function consumeRateLimit(
  name: RateLimitName,
  identifier: string
): Promise<RateLimitResult> {
  const { limits } = await effectiveLimits()
  const { limit, windowSeconds } = limits[name]
  return spendToken(
    `${name}:${identifier}`,
    bucketFor(limit, windowSeconds),
    new Date()
  )
}

/** `consumeRateLimit` for one key, bucket and moment; see above. */
export async function spendToken(
  key: string,
  config: BucketConfig,
  now: Date
): Promise<RateLimitResult> {
  const nowSeconds = now.getTime() / 1000
  const burst = config.burst
  const rate = config.refillPerSecond

  const [row] = await prisma.$queryRaw<
    { spent: number | null; available: number | null }[]
  >`
    WITH spent AS (
      INSERT INTO "RateLimit" ("key", "tokens", "updatedAt")
      VALUES (
        ${key},
        ${burst}::float8 - 1,
        to_timestamp(${nowSeconds}::float8) AT TIME ZONE 'UTC'
      )
      ON CONFLICT ("key") DO UPDATE SET
        "tokens" = LEAST(
          ${burst}::float8,
          "RateLimit"."tokens" + GREATEST(
            0,
            ${nowSeconds}::float8 - EXTRACT(EPOCH FROM "RateLimit"."updatedAt")
          ) * ${rate}::float8
        ) - 1,
        "updatedAt" = to_timestamp(${nowSeconds}::float8) AT TIME ZONE 'UTC'
      WHERE LEAST(
          ${burst}::float8,
          "RateLimit"."tokens" + GREATEST(
            0,
            ${nowSeconds}::float8 - EXTRACT(EPOCH FROM "RateLimit"."updatedAt")
          ) * ${rate}::float8
        ) >= 1
      RETURNING "tokens"
    )
    SELECT
      (SELECT "tokens" FROM spent)::float8 AS spent,
      (
        SELECT LEAST(
          ${burst}::float8,
          "tokens" + GREATEST(
            0,
            ${nowSeconds}::float8 - EXTRACT(EPOCH FROM "updatedAt")
          ) * ${rate}::float8
        )
        FROM "RateLimit"
        WHERE "key" = ${key}
      )::float8 AS available
  `

  if (row && row.spent !== null) {
    return { allowed: true, remaining: Math.floor(row.spent), resetAt: now }
  }

  const available = Math.max(0, Math.min(1, row?.available ?? 0))
  return {
    allowed: false,
    remaining: 0,
    resetAt: new Date(
      now.getTime() + Math.ceil(((1 - available) / rate) * 1000)
    ),
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
