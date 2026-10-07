import { randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import { bucketFor, consume, freshState } from "@/lib/security/token-bucket"
import type { RateStore } from "@/lib/services/rate-store"

/**
 * What every RateStore must answer (#184), run against the memory reference
 * in `pnpm test` and against Postgres and Redis/Valkey in `pnpm test:db`.
 *
 * `waitSlackMs` is how far a store's wait may stray from the reference's:
 * Postgres keeps `updatedAt` to the millisecond, so its waits can be a
 * millisecond or two off. The memory store and the Lua script compute in the
 * same order as token-bucket.ts and must agree exactly.
 */
export function rateStoreContract(
  name: string,
  store: () => RateStore,
  {
    waitSlackMs = 0,
    skip = false,
  }: { waitSlackMs?: number; skip?: boolean } = {}
): void {
  const key = (label: string) =>
    `test:${label}:${randomBytes(6).toString("hex")}`

  describe.skipIf(skip)(`the ${name} rate store`, () => {
    it("spends a burst, then says how long to wait", async () => {
      const k = key("burst")
      const config = bucketFor(3, 60) // three a minute: one every 20 s
      const now = new Date()
      const answers = []
      for (let i = 0; i < 4; i++)
        answers.push(await store().take(k, config, now))

      expect(answers.map((a) => a.allowed)).toEqual([true, true, true, false])
      expect(answers.map((a) => a.remaining)).toEqual([2, 1, 0, 0])
      expect(Math.abs(answers[3].waitMs - 20_000)).toBeLessThanOrEqual(
        waitSlackMs
      )
    })

    it("answers as token-bucket.ts does, request by request", async () => {
      for (const seed of [1, 2, 3]) {
        const next = random(seed)
        const k = key(`property-${seed}`)
        const config = bucketFor(5, 10)
        let clock = Date.UTC(2026, 0, 1)
        let reference = freshState(config, new Date(clock))

        for (let i = 0; i < 60; i++) {
          clock +=
            next() < 0.7 ? Math.floor(next() * 400) : Math.floor(next() * 8000)
          const now = new Date(clock)
          const expected = consume(reference, config, now)
          reference = expected.state
          const actual = await store().take(k, config, now)

          const at = `seed ${seed}, request ${i}`
          expect(actual.allowed, at).toBe(expected.allowed)
          expect(actual.remaining, at).toBe(expected.remaining)
          expect(
            Math.abs(actual.waitMs - expected.retryAfterMs),
            at
          ).toBeLessThanOrEqual(waitSlackMs)
        }
      }
    })

    it("peeks without spending", async () => {
      const k = key("peek")
      const config = bucketFor(2, 60)
      const now = new Date()
      expect((await store().peek(k, config, now)).remaining).toBe(2)
      await store().take(k, config, now)
      expect((await store().peek(k, config, now)).remaining).toBe(1)
      expect((await store().peek(k, config, now)).remaining).toBe(1)
    })

    it("holds the next token back for a Retry-After, and never adds one", async () => {
      const k = key("defer")
      const config = bucketFor(60, 60) // one a second, a burst of sixty
      const now = new Date()

      await store().defer(k, config, now, 5_000)
      const refused = await store().take(k, config, now)
      expect(refused.allowed).toBe(false)
      expect(Math.abs(refused.waitMs - 5_000)).toBeLessThanOrEqual(waitSlackMs)
      const later = new Date(now.getTime() + 5_000)
      expect((await store().take(k, config, later)).allowed).toBe(true)

      // A Retry-After shorter than the bucket's own wait changes nothing.
      const k2 = key("defer-short")
      const slow = bucketFor(1, 60)
      await store().take(k2, slow, now)
      await store().defer(k2, slow, now, 10)
      const wait = (await store().take(k2, slow, now)).waitMs
      expect(Math.abs(wait - 60_000)).toBeLessThanOrEqual(waitSlackMs)
    })

    it("holds a lease limit, and frees a released slot", async () => {
      const k = key("lease")
      const held = []
      for (let i = 0; i < 3; i++)
        held.push(await store().acquireLease(k, 3, 30_000))
      expect(held.every(Boolean)).toBe(true)
      expect(await store().acquireLease(k, 3, 30_000)).toBeNull()

      await store().releaseLease(k, held[0]!.id)
      expect(await store().renewLease(k, held[0]!.id, 30_000)).toBe(false)
      expect(await store().renewLease(k, held[1]!.id, 30_000)).toBe(true)
      expect(await store().acquireLease(k, 3, 30_000)).not.toBeNull()
      expect(await store().acquireLease(k, 3, 30_000)).toBeNull()
    })

    it("lets a lease nobody renews expire", async () => {
      const k = key("expiry")
      const lease = await store().acquireLease(k, 1, 100)
      expect(lease).not.toBeNull()
      expect(await store().acquireLease(k, 1, 100)).toBeNull()

      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(await store().renewLease(k, lease!.id, 100)).toBe(false)
      expect(await store().acquireLease(k, 1, 30_000)).not.toBeNull()
    })

    it("keeps a lowered limit while the slots above it are in flight", async () => {
      // The spend cap drops the gateway to one call at a time.
      const k = key("ceiling")
      for (let i = 0; i < 3; i++)
        expect(await store().acquireLease(k, 3, 30_000)).not.toBeNull()
      expect(await store().acquireLease(k, 1, 30_000)).toBeNull()
    })

    it("never grants more than the limit to requests that arrive at once", async () => {
      const k = key("race")
      const granted = (
        await Promise.all(
          Array.from({ length: 20 }, () => store().acquireLease(k, 5, 30_000))
        )
      ).filter(Boolean)
      expect(granted.length).toBeGreaterThanOrEqual(1)
      expect(granted.length).toBeLessThanOrEqual(5)

      // Those that lost a race for a slot ask again and find the rest.
      let more = 0
      while ((await store().acquireLease(k, 5, 30_000)) !== null) more++
      expect(granted.length + more).toBe(5)
    })
  })
}

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
