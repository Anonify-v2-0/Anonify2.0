import { afterAll, describe, expect, it } from "vitest"

import { hasDatabase, testId } from "./support"

/**
 * The rate limiter's one statement against a real Postgres (#171): the
 * decision is atomic under concurrency, and it gives the same answers as the
 * reference implementation in token-bucket.ts.
 */

const { prisma } = await import("@/lib/database/prisma")
const { spendToken } = await import("@/lib/security/rate-limit")
const { bucketFor, consume, freshState } =
  await import("@/lib/security/token-bucket")

const keys: string[] = []
function key(label: string): string {
  const value = `test:${testId(label)}`
  keys.push(value)
  return value
}

afterAll(async () => {
  if (hasDatabase)
    await prisma.rateLimit.deleteMany({ where: { key: { in: keys } } })
})

/** A small deterministic generator, so a failure can be replayed. */
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe.skipIf(!hasDatabase)("the rate limiter against Postgres", () => {
  it("admits exactly the limit when 200 requests arrive at once", async () => {
    const k = key("burst")
    // Fifty a day: nothing refills while the test runs.
    const config = bucketFor(50, 86_400)
    const now = new Date()
    const results = await Promise.all(
      Array.from({ length: 200 }, () => spendToken(k, config, now))
    )
    expect(results.filter((r) => r.allowed)).toHaveLength(50)
    expect(results.filter((r) => !r.allowed)).toHaveLength(150)
  })

  it("answers as the reference implementation does, request by request", async () => {
    for (const seed of [1, 2, 3]) {
      const next = random(seed)
      const k = key(`property-${seed}`)
      const config = bucketFor(5, 10) // five per ten seconds, half a token a second
      let clock = Date.UTC(2026, 0, 1)
      let reference = freshState(config, new Date(clock))

      for (let i = 0; i < 60; i++) {
        // Mostly bursts, sometimes a pause long enough to refill.
        clock +=
          next() < 0.7 ? Math.floor(next() * 400) : Math.floor(next() * 8000)
        const now = new Date(clock)
        const expected = consume(reference, config, now)
        // The reference persists its refusals; storing them or not gives the
        // same balances, which is what this compares.
        reference = expected.state
        const actual = await spendToken(k, config, now)

        expect(actual.allowed, `seed ${seed}, request ${i}`).toBe(
          expected.allowed
        )
        expect(actual.remaining, `seed ${seed}, request ${i}`).toBe(
          expected.remaining
        )
        // Milliseconds of rounding: updatedAt is stored to the millisecond.
        const expectedReset = now.getTime() + expected.retryAfterMs
        expect(
          Math.abs(actual.resetAt.getTime() - expectedReset),
          `seed ${seed}, request ${i}`
        ).toBeLessThanOrEqual(2)
      }
    }
  })
})
