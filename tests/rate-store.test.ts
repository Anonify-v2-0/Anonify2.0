import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest"

import { deferBucket, refill } from "@/lib/security/token-bucket"
import {
  rateStoreKind,
  resetRateStoreFailures,
  serviceLimitScope,
  type RateStore,
} from "@/lib/services/rate-store"
import { redisConfigFromEnv } from "@/lib/services/rate-store-redis"
import {
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  resetThrottles,
  runThrottled,
  throttleState,
  useRateStore,
} from "@/lib/services/throttle"

import { memoryRateStore } from "./helpers/memory-rate-store"
import { rateStoreContract } from "./helpers/rate-store-contract"

/**
 * The cluster-wide budget for the AI and OCR calls (#184): its configuration,
 * the store contract against the in-memory reference, and the throttle
 * running a "cluster" whose other replicas are leases already in the store.
 * The Postgres and Redis stores, and several real processes sharing one, are
 * in tests/integration/rate-store.integration.test.ts.
 */

let warnings: MockInstance<typeof console.warn>

beforeEach(() => {
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  resetThrottles()
  resetRateStoreFailures()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("configuration", () => {
  it("is the process unless asked otherwise, so one box changes nothing", () => {
    expect(serviceLimitScope({})).toBe("process")
    expect(serviceLimitScope({ ANONIFY_SERVICE_LIMIT_SCOPE: "Cluster" })).toBe(
      "cluster"
    )
    expect(() =>
      serviceLimitScope({ ANONIFY_SERVICE_LIMIT_SCOPE: "global" })
    ).toThrow(/ANONIFY_SERVICE_LIMIT_SCOPE/)
  })

  it("keeps the budget in Postgres unless Redis is named, with a URL", () => {
    expect(rateStoreKind({})).toBe("postgres")
    expect(
      rateStoreKind({
        ANONIFY_RATE_STORE: "redis",
        REDIS_URL: "redis://cache:6379",
      })
    ).toBe("redis")
    expect(() => rateStoreKind({ ANONIFY_RATE_STORE: "redis" })).toThrow(
      /REDIS_URL/
    )
    expect(() => rateStoreKind({ ANONIFY_RATE_STORE: "memcached" })).toThrow(
      /ANONIFY_RATE_STORE/
    )
  })

  it("reads REDIS_URL, a prefix, and cluster mode, and refuses a bad URL", () => {
    expect(
      redisConfigFromEnv({ REDIS_URL: "rediss://:pw@cache:6380" })
    ).toEqual({
      url: "rediss://:pw@cache:6380",
      prefix: "anonify:",
      cluster: false,
    })
    expect(
      redisConfigFromEnv({
        REDIS_URL: "redis://cache",
        REDIS_KEY_PREFIX: "prod:",
        REDIS_CLUSTER: "true",
      })
    ).toMatchObject({ prefix: "prod:", cluster: true })
    expect(() => redisConfigFromEnv({ REDIS_URL: "http://cache" })).toThrow(
      /redis:\/\/ or rediss:\/\//
    )
    expect(() => redisConfigFromEnv({})).toThrow(/REDIS_URL/)
    expect(() =>
      redisConfigFromEnv({ REDIS_URL: "redis://cache", REDIS_CLUSTER: "yes" })
    ).toThrow(/REDIS_CLUSTER/)
  })
})

describe("deferring a bucket for a Retry-After", () => {
  const config = { burst: 10, refillPerSecond: 2 }
  const now = new Date(Date.UTC(2026, 0, 1))

  it("puts the next token exactly where the provider said", () => {
    const deferred = deferBucket(
      { tokens: 10, updatedAt: now },
      config,
      now,
      3_000
    )
    expect(
      refill(deferred, config, new Date(now.getTime() + 2_999))
    ).toBeLessThan(1)
    expect(refill(deferred, config, new Date(now.getTime() + 3_000))).toBe(1)
  })

  it("never gives a bucket more than it had", () => {
    const empty = { tokens: 0, updatedAt: now }
    expect(deferBucket(empty, config, now, 0).tokens).toBe(0)
  })
})

const memory = memoryRateStore()
rateStoreContract("memory", () => memory)

describe("the throttle with a cluster-wide store", () => {
  /** Runs `count` requests that each wait to be let go, and reports the peak. */
  async function peakInFlight(count: number): Promise<number> {
    let peak = 0
    let inFlight = 0
    const release: (() => void)[] = []
    const runs = Array.from({ length: count }, () =>
      runThrottled("ai", { label: "test" }, async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise<void>((resolve) => release.push(resolve))
        inFlight -= 1
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    while (release.length > 0 || inFlight > 0) {
      release.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    await Promise.all(runs)
    return peak
  }

  it("counts what other replicas have in flight", async () => {
    vi.stubEnv("ANONIFY_AI_CONCURRENCY", "3")
    const store = memoryRateStore()
    useRateStore(store)

    // Two calls held by another replica: this one may have one at a time.
    await store.acquireLease("svc:ai:lease", 3, 60_000)
    const other = await store.acquireLease("svc:ai:lease", 3, 60_000)
    expect(await peakInFlight(3)).toBe(1)

    // That replica finishes one, and this one may have two.
    await store.releaseLease("svc:ai:lease", other!.id)
    expect(await peakInFlight(3)).toBe(2)
    expect(throttleState("ai")).toMatchObject({ active: 0, scope: "cluster" })
  })

  it("gives every lease back, whatever the request did", async () => {
    const store = memoryRateStore()
    const release = vi.spyOn(store, "releaseLease")
    useRateStore(store)

    await runThrottled("ai", { label: "test" }, async () => "ok")
    await expect(
      runThrottled("ai", { label: "test", maxAttempts: 1 }, async () => {
        throw Object.assign(new Error("bad key"), { statusCode: 401 })
      })
    ).rejects.toThrow("bad key")

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(await store.acquireLease("svc:ai:lease", 1, 1_000)).not.toBeNull()
  })

  it("renews a lease while its request is in flight", async () => {
    vi.useFakeTimers()
    const store = memoryRateStore()
    const renew = vi.spyOn(store, "renewLease")
    useRateStore(store)

    let finish!: () => void
    const run = runThrottled(
      "ai",
      { label: "long generation" },
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 4)
    expect(renew).toHaveBeenCalledTimes(4)
    expect(renew).toHaveBeenLastCalledWith(
      "svc:ai:lease",
      expect.any(String),
      LEASE_TTL_MS
    )

    finish()
    await run
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 2)
    expect(renew).toHaveBeenCalledTimes(4)
  })

  it("paces the deployment from the shared bucket", async () => {
    vi.stubEnv("ANONIFY_OCR_REQUESTS_PER_MINUTE", "60")
    const store = memoryRateStore()
    const take = vi.spyOn(store, "take")
    useRateStore(store)

    // Another replica just spent the only token.
    await store.take(
      "svc:ocr:rpm",
      { burst: 1, refillPerSecond: 1 },
      new Date()
    )

    const started = Date.now()
    await runThrottled("ocr", { label: "page" }, async () => null)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(take).toHaveBeenCalledWith(
      "svc:ocr:rpm",
      { burst: 1, refillPerSecond: 1 },
      expect.any(Date)
    )
  }, 10_000)

  it("tells every replica about a Retry-After", async () => {
    vi.stubEnv("ANONIFY_OCR_REQUESTS_PER_MINUTE", "600")
    const store = memoryRateStore()
    const defer = vi.spyOn(store, "defer")
    useRateStore(store)

    let calls = 0
    await runThrottled("ocr", { label: "page", maxAttempts: 2 }, async () => {
      calls += 1
      if (calls === 1)
        throw Object.assign(new Error("429"), {
          statusCode: 429,
          responseHeaders: { "retry-after": "0.2" },
        })
      return null
    })

    expect(defer).toHaveBeenCalledWith(
      "svc:ocr:rpm",
      { burst: 10, refillPerSecond: 10 },
      expect.any(Date),
      200
    )
  })

  it("does not defer where no rate is configured, as there is no bucket", async () => {
    const store = memoryRateStore()
    const defer = vi.spyOn(store, "defer")
    useRateStore(store)

    let calls = 0
    await runThrottled("ai", { label: "test", maxAttempts: 2 }, async () => {
      calls += 1
      if (calls === 1)
        throw Object.assign(new Error("429"), {
          statusCode: 429,
          responseHeaders: { "retry-after": "0.01" },
        })
    })
    expect(defer).not.toHaveBeenCalled()
  })
})

describe("when the store cannot be reached", () => {
  function brokenStore(): RateStore {
    const down = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:6379")
    }
    return {
      kind: "redis",
      take: down,
      peek: down,
      defer: down,
      acquireLease: down,
      renewLease: down,
      releaseLease: down,
      probe: down,
    }
  }

  it("keeps processing on the process-local gate, and says so once", async () => {
    vi.stubEnv("ANONIFY_OCR_REQUESTS_PER_MINUTE", "6000")
    vi.stubEnv("ANONIFY_OCR_CONCURRENCY", "2")
    useRateStore(brokenStore())

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runThrottled("ocr", { label: "page" }, async () => i)
      )
    )
    expect(results).toEqual([0, 1, 2, 3, 4, 5])

    const lines = warnings.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { context?: string })
      .filter((line) => line.context === "service.rate-store")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: "warn",
      store: "redis",
      use: "outbound",
      fallback: "process",
    })
    expect(throttleState("ocr").fallbacks).toBeGreaterThanOrEqual(1)
    expect(throttleState("ocr").active).toBe(0)
  })

  it("still holds the configured concurrency, per process", async () => {
    vi.stubEnv("ANONIFY_AI_CONCURRENCY", "2")
    useRateStore(brokenStore())

    let peak = 0
    let inFlight = 0
    await Promise.all(
      Array.from({ length: 5 }, () =>
        runThrottled("ai", { label: "test" }, async () => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 10))
          inFlight -= 1
        })
      )
    )
    expect(peak).toBe(2)
  })

  it("does not ask the store again for a while after it failed", async () => {
    const store = brokenStore()
    const acquire = vi.spyOn(store, "acquireLease")
    useRateStore(store)

    for (let i = 0; i < 5; i++)
      await runThrottled("ai", { label: "test" }, async () => null)
    expect(acquire).toHaveBeenCalledTimes(1)
  })
})
