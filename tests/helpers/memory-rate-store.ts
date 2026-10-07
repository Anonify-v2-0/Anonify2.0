import { randomUUID } from "node:crypto"

import {
  consume,
  deferBucket,
  freshState,
  refill,
  type BucketState,
} from "@/lib/security/token-bucket"
import type { RateStore } from "@/lib/services/rate-store"

/**
 * The RateStore contract in memory: token-bucket.ts for the bucket and a map
 * of expiry times for the leases. It is the reference the Postgres and Redis
 * stores are held to, and the store the throttle's unit tests run a cluster
 * against. Production never uses it; the process scope is the throttle's own
 * gate.
 */
export function memoryRateStore(): RateStore {
  const buckets = new Map<string, BucketState>()
  const leases = new Map<string, Map<string, number>>()

  function live(key: string): Map<string, number> {
    const held = leases.get(key) ?? new Map<string, number>()
    leases.set(key, held)
    const now = Date.now()
    for (const [id, expiresAt] of held) if (expiresAt <= now) held.delete(id)
    return held
  }

  return {
    kind: "memory",

    async take(key, config, now) {
      const decision = consume(
        buckets.get(key) ?? freshState(config, now),
        config,
        now
      )
      buckets.set(key, decision.state)
      return {
        allowed: decision.allowed,
        remaining: decision.remaining,
        waitMs: decision.retryAfterMs,
      }
    },

    async peek(key, config, now) {
      const available = refill(
        buckets.get(key) ?? freshState(config, now),
        config,
        now
      )
      return available >= 1
        ? { allowed: true, remaining: Math.floor(available), waitMs: 0 }
        : {
            allowed: false,
            remaining: 0,
            waitMs: Math.ceil(
              ((1 - available) / config.refillPerSecond) * 1000
            ),
          }
    },

    async defer(key, config, now, waitMs) {
      buckets.set(
        key,
        deferBucket(
          buckets.get(key) ?? freshState(config, now),
          config,
          now,
          waitMs
        )
      )
    },

    async acquireLease(key, limit, ttlMs) {
      const held = live(key)
      if (held.size >= limit) return null
      const id = randomUUID()
      held.set(id, Date.now() + ttlMs)
      return { id }
    },

    async renewLease(key, id, ttlMs) {
      const held = live(key)
      if (!held.has(id)) return false
      held.set(id, Date.now() + ttlMs)
      return true
    },

    async releaseLease(key, id) {
      leases.get(key)?.delete(id)
    },

    async probe() {},
  }
}
