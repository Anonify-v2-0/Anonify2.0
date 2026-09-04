import { RATE_LIMITS, type RateLimitName } from "@/lib/config"
import { prisma } from "@/lib/database/prisma"

/**
 * Server-side fixed-window rate limiting. Client-side throttling is decoration;
 * this is the control that actually holds. State lives in Postgres so it is
 * shared across serverless instances.
 */

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetAt: Date
}

export async function consumeRateLimit(
  name: RateLimitName,
  identifier: string
): Promise<RateLimitResult> {
  const { limit, windowSeconds } = RATE_LIMITS[name]
  const now = Date.now()
  const windowStart = new Date(
    Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000
  )
  const key = `${name}:${identifier}:${windowStart.getTime()}`
  const resetAt = new Date(windowStart.getTime() + windowSeconds * 1000)

  const record = await prisma.rateLimit.upsert({
    where: { key },
    create: { key, windowStart, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  })

  return {
    allowed: record.count <= limit,
    remaining: Math.max(0, limit - record.count),
    resetAt,
  }
}

/** Best-effort cleanup of expired windows; safe to call repeatedly. */
export async function pruneRateLimits(olderThanMinutes = 60): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000)
  const result = await prisma.rateLimit.deleteMany({
    where: { windowStart: { lt: cutoff } },
  })
  return result.count
}
