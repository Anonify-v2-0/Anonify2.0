import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { promisify } from "node:util"

import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { memoryRateStore } from "../helpers/memory-rate-store"
import { rateStoreContract } from "../helpers/rate-store-contract"
import { hasDatabase, testId } from "./support"

/**
 * The cluster-wide AI and OCR budget against real stores (#184): the store
 * contract on Postgres and on Redis/Valkey, several processes sharing one
 * limit, and what happens when Redis goes away mid-run.
 *
 * Redis is `TEST_REDIS_URL`, never `REDIS_URL`, for the reason support.ts
 * gives about databases. CI runs a Valkey service beside Postgres.
 */

const { prisma } = await import("@/lib/database/prisma")
const { postgresRateStore } = await import("@/lib/services/rate-store-postgres")
const { closeRedis, redisRateStore } =
  await import("@/lib/services/rate-store-redis")
const { resetRateStoreFailures } = await import("@/lib/services/rate-store")
const { resetThrottles, runThrottled, throttleState, useRateStore } =
  await import("@/lib/services/throttle")
const { consumeRateLimit } = await import("@/lib/security/rate-limit")

const TEST_REDIS_URL = process.env.TEST_REDIS_URL?.trim()
const hasRedis = Boolean(TEST_REDIS_URL)
const prefix = `test-${randomBytes(4).toString("hex")}:`

const stores = {
  postgres: { available: hasDatabase, make: () => postgresRateStore() },
  redis: {
    available: hasRedis,
    make: () =>
      redisRateStore({ url: TEST_REDIS_URL!, prefix, cluster: false }),
  },
}

const postgres = hasDatabase ? stores.postgres.make() : memoryRateStore()
const redis = hasRedis ? stores.redis.make() : memoryRateStore()

afterEach(() => {
  resetThrottles()
  resetRateStoreFailures()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

afterAll(async () => {
  if (hasDatabase) {
    await prisma.serviceLease.deleteMany({
      where: { key: { startsWith: "test:" } },
    })
    await prisma.rateLimit.deleteMany({
      where: { key: { startsWith: "test:" } },
    })
  }
  await closeRedis()
})

rateStoreContract("Postgres", () => postgres, {
  waitSlackMs: 2,
  skip: !hasDatabase,
})
rateStoreContract("Redis", () => redis, { skip: !hasRedis })

// --- several processes, one limit -------------------------------------------

const child = path.resolve(import.meta.dirname, "fixtures/rate-store-child.ts")
const run = promisify(execFile)

async function replicas(
  count: number,
  env: Record<string, string>
): Promise<unknown[]> {
  const outputs = await Promise.all(
    Array.from({ length: count }, () =>
      run(process.execPath, ["--import", "tsx", child], {
        env: {
          ...process.env,
          ...(TEST_REDIS_URL
            ? { REDIS_URL: TEST_REDIS_URL, REDIS_KEY_PREFIX: prefix }
            : {}),
          ...env,
        },
        timeout: 60_000,
      })
    )
  )
  return outputs.map(({ stdout }) =>
    JSON.parse(stdout.trim().split("\n").pop()!)
  )
}

/** Counts what the replicas say they hold, and the most at once. */
async function inFlightCounter() {
  let current = 0
  let peak = 0
  const server = http.createServer((request, response) => {
    current += request.url === "/in" ? 1 : -1
    peak = Math.max(peak, current)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    peak: () => peak,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

for (const [name, { available }] of Object.entries(stores)) {
  describe.skipIf(!available)(`four processes sharing ${name}`, () => {
    it("never have more than the limit in flight between them", async () => {
      const counter = await inFlightCounter()
      const results = (await replicas(4, {
        STORE: name,
        MODE: "lease",
        KEY: `test:${testId("lease")}`,
        LIMIT: "3",
        HOLD_MS: "40",
        ROUNDS: "6",
        COUNTER_URL: counter.url,
      })) as { rounds: number }[]
      await counter.close()

      expect(results.reduce((sum, r) => sum + r.rounds, 0)).toBe(24)
      expect(counter.peak()).toBeLessThanOrEqual(3)
      // And they did run side by side, or the bound proves nothing.
      expect(counter.peak()).toBeGreaterThanOrEqual(2)
    }, 90_000)

    it("share one rate between them", async () => {
      // 600 a minute is ten a second with a burst of ten: over two seconds,
      // ten at once and twenty more, however many processes are asking.
      const start = Date.now() + 8_000
      const results = (await replicas(4, {
        STORE: name,
        MODE: "rate",
        KEY: `test:${testId("rate")}`,
        RPM: "600",
        START: String(start),
        UNTIL: String(start + 2_000),
      })) as { allowed: number }[]

      const allowed = results.reduce((sum, r) => sum + r.allowed, 0)
      expect(allowed).toBeLessThanOrEqual(10 + 20 + 1)
      expect(allowed).toBeGreaterThanOrEqual(20)
    }, 90_000)
  })
}

// --- Redis going away -------------------------------------------------------

/** A TCP relay to Redis that can be cut, as a network partition would. */
async function relay(target: URL) {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 6379), target.hostname)
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on("error", () => {})
      socket.on("close", () => sockets.delete(socket))
    }
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo
  const url = new URL(target)
  url.hostname = "127.0.0.1"
  url.port = String(port)
  return {
    url: url.toString(),
    cut: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe.skipIf(!hasRedis)("when Redis goes away", () => {
  it("keeps outbound calls running on the process, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const link = await relay(new URL(TEST_REDIS_URL!))
    const store = redisRateStore({ url: link.url, prefix, cluster: false })
    useRateStore(store)
    vi.stubEnv("ANONIFY_OCR_REQUESTS_PER_MINUTE", "6000")

    const page = (i: number) =>
      runThrottled("ocr", { label: "page" }, async () => i)

    expect(await Promise.all([0, 1, 2].map(page))).toEqual([0, 1, 2])
    expect(throttleState("ocr").fallbacks).toBe(0)

    await link.cut()
    expect(await Promise.all([3, 4, 5, 6].map(page))).toEqual([3, 4, 5, 6])
    expect(throttleState("ocr").fallbacks).toBeGreaterThanOrEqual(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"context":"service.rate-store"')
    )
    await closeRedis()
  }, 30_000)

  it.skipIf(!hasDatabase)(
    "moves the inbound limiter to Redis, and back to Postgres without it",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const identifier = testId("inbound")
      const key = `upload:${identifier}`

      vi.stubEnv("ANONIFY_RATE_STORE", "redis")
      vi.stubEnv("REDIS_URL", TEST_REDIS_URL!)
      vi.stubEnv("REDIS_KEY_PREFIX", prefix)
      expect((await consumeRateLimit("upload", identifier)).allowed).toBe(true)
      expect(await prisma.rateLimit.findUnique({ where: { key } })).toBeNull()
      await closeRedis()

      vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1")
      expect((await consumeRateLimit("upload", identifier)).allowed).toBe(true)
      expect(
        await prisma.rateLimit.findUnique({ where: { key } })
      ).not.toBeNull()
      await prisma.rateLimit.delete({ where: { key } })
      await closeRedis()
    },
    30_000
  )
})
