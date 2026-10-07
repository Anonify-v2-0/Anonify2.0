import { randomUUID } from "node:crypto"

import { prisma } from "@/lib/database/prisma"
import { deferToken, peekBucket, spendToken } from "@/lib/security/rate-limit"
import type { RateStore } from "@/lib/services/rate-store"

/**
 * The cluster budget in Postgres (#184), which every deployment already has.
 *
 * The bucket is the inbound limiter's single statement (#171), under keys of
 * its own (`svc:ai:rpm`), so its rows are pruned by the same sweep.
 *
 * Leases are slots. A limit of N is slots 0 to N-1 in "ServiceLease", and an
 * acquire is one statement that claims a free one: inserting a slot nobody
 * has held, or overwriting one whose lease has expired. Two replicas reaching
 * for the same slot at once meet at its primary key, and Postgres decides the
 * `ON CONFLICT … WHERE` against the row it has locked, so the loser gets no
 * row back rather than a second copy of the slot. A loser that could have had
 * another slot just asks again, and the slot is chosen at random so that
 * happens rarely. Counting live leases under an advisory lock, as #184 first
 * proposed, needs a transaction of two statements to see the rows other
 * replicas committed while it waited for the lock; the slot needs one
 * statement and no lock.
 *
 * The live-lease count in the WHERE is not what makes this safe, the slots
 * are. It covers the moment a limit is lowered (the spend cap's ceiling of
 * one): a slot below the new limit can be free while slots above it are
 * still in flight, and the count keeps a new request out until they finish.
 *
 * Expiry is the database's clock, `now()`, not this process's, so replicas
 * whose clocks disagree still agree on which leases are live.
 */
export function postgresRateStore(): RateStore {
  return {
    kind: "postgres",

    async take(key, config, now) {
      const result = await spendToken(key, config, now)
      return {
        allowed: result.allowed,
        remaining: result.remaining,
        waitMs: Math.max(0, result.resetAt.getTime() - now.getTime()),
      }
    },

    async peek(key, config, now) {
      const result = await peekBucket(key, config, now)
      return {
        allowed: result.allowed,
        remaining: result.remaining,
        waitMs: Math.max(0, result.resetAt.getTime() - now.getTime()),
      }
    },

    defer: deferToken,

    async acquireLease(key, limit, ttlMs) {
      const id = randomUUID()
      const rows = await prisma.$queryRaw<{ slot: number }[]>`
        INSERT INTO "ServiceLease" ("key", "slot", "id", "expiresAt")
        SELECT
          ${key},
          s,
          ${id},
          now() + ${ttlMs}::float8 * interval '1 millisecond'
        FROM generate_series(0, ${limit}::int - 1) AS s
        WHERE NOT EXISTS (
            SELECT 1 FROM "ServiceLease" l
            WHERE l."key" = ${key} AND l."slot" = s AND l."expiresAt" > now()
          )
          AND (
            SELECT count(*) FROM "ServiceLease" l
            WHERE l."key" = ${key} AND l."expiresAt" > now()
          ) < ${limit}::int
        ORDER BY random()
        LIMIT 1
        ON CONFLICT ("key", "slot") DO UPDATE SET
          "id" = EXCLUDED."id",
          "expiresAt" = EXCLUDED."expiresAt"
        WHERE "ServiceLease"."expiresAt" <= now()
        RETURNING "slot"
      `
      return rows.length > 0 ? { id } : null
    },

    async renewLease(key, id, ttlMs) {
      const renewed = await prisma.$executeRaw`
        UPDATE "ServiceLease"
        SET "expiresAt" = now() + ${ttlMs}::float8 * interval '1 millisecond'
        WHERE "key" = ${key} AND "id" = ${id} AND "expiresAt" > now()
      `
      return renewed > 0
    },

    async releaseLease(key, id) {
      await prisma.$executeRaw`
        DELETE FROM "ServiceLease" WHERE "key" = ${key} AND "id" = ${id}
      `
    },

    async probe() {
      await prisma.$queryRaw`SELECT 1`
    },
  }
}
