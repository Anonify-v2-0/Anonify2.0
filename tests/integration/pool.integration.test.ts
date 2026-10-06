import { randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import { hasDatabase, TEST_DATABASE_URL } from "./support"

/**
 * DATABASE_POOL_MAX against a real Postgres (#169): a pool of two queues
 * twenty concurrent queries rather than refusing them, and never holds more
 * than two connections while it does.
 */

const { PrismaPg } = await import("@prisma/adapter-pg")
const { PrismaClient } = await import("@/lib/database/generated/client")
const { databasePoolConfig } = await import("@/lib/database/pool-config")

describe.skipIf(!hasDatabase)("the app's pool size against Postgres", () => {
  it("queues past DATABASE_POOL_MAX instead of opening more connections", async () => {
    // Its own name, so pg_stat_activity can count this pool's connections alone.
    const name = `anonify_pool_test_${randomBytes(4).toString("hex")}`
    const client = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: TEST_DATABASE_URL,
        application_name: name,
        ...databasePoolConfig({ DATABASE_POOL_MAX: "2" }),
      }),
    })
    const watcher = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
    })
    try {
      let peak = 0
      let running = true
      const watching = (async () => {
        while (running) {
          const [row] = await watcher.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = ${name}`
          peak = Math.max(peak, Number(row.n))
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      })()

      const results = await Promise.all(
        Array.from(
          { length: 20 },
          () => client.$queryRaw`SELECT pg_sleep(0.05)::text AS slept, 1 AS ok`
        )
      )
      running = false
      await watching

      expect(results).toHaveLength(20)
      expect(peak).toBeGreaterThan(0)
      expect(peak).toBeLessThanOrEqual(2)
    } finally {
      await client.$disconnect()
      await watcher.$disconnect()
    }
  })
})
