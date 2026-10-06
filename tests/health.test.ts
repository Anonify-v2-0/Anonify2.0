import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const query = vi.fn()
const probe = vi.fn()

vi.mock("@/lib/database/prisma", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => query(...args) },
}))
vi.mock("@/lib/storage/blob", () => ({
  probeStorage: () => probe(),
}))

const { GET: health } = await import("@/app/api/health/route")
const { GET: ready } = await import("@/app/api/ready/route")
const { cachedReadiness, checkReadiness, clearReadinessCache, readyTimeoutMs } =
  await import("@/lib/health/ready")
const { markDraining, markWorldStarted, resetHealthState } =
  await import("@/lib/health/state")

let errors: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetHealthState()
  clearReadinessCache()
  query.mockReset().mockResolvedValue([{ "?column?": 1 }])
  probe.mockReset().mockResolvedValue(undefined)
  errors = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("liveness (#167)", () => {
  it("answers 200 without touching the database or storage", async () => {
    query.mockRejectedValue(new Error("database is down"))
    const response = health()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(query).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })
})

describe("readiness (#167)", () => {
  it("reports each dependency and how long it took", async () => {
    const answer = await checkReadiness({
      database: async () => {},
      storage: async () => {},
    })
    expect(answer.status).toBe("ready")
    if (answer.status === "ready")
      expect(Object.keys(answer.checks)).toEqual(["database", "storage"])
  })

  it("names what failed, and never what it said", async () => {
    const answer = await checkReadiness({
      database: async () => {
        throw new Error("connect ECONNREFUSED postgresql://anonify:secret@db")
      },
      storage: async () => {},
    })
    expect(answer).toEqual({ status: "not-ready", failed: ["database"] })
    expect(JSON.stringify(answer)).not.toContain("secret")
    // The detail goes to the operator's log.
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('"check":"database"')
    )
  })

  it("fails a check that does not answer in time", async () => {
    const answer = await checkReadiness(
      { storage: () => new Promise(() => {}) },
      20
    )
    expect(answer).toEqual({ status: "not-ready", failed: ["storage"] })
  })

  it("is not ready while draining, without checking anything", async () => {
    const check = vi.fn(async () => {})
    markDraining()
    expect(await checkReadiness({ database: check })).toEqual({
      status: "not-ready",
      failed: ["draining"],
    })
    expect(check).not.toHaveBeenCalled()
  })

  it("answers a burst of probes from one second's result", async () => {
    const check = vi.fn(async () => {})
    await cachedReadiness(() => ({ database: check }), 100, 1000)
    await cachedReadiness(() => ({ database: check }), 100, 1500)
    expect(check).toHaveBeenCalledTimes(1)
    await cachedReadiness(() => ({ database: check }), 100, 2100)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it("refuses a timeout that is not a whole number of milliseconds", () => {
    expect(readyTimeoutMs({})).toBe(2000)
    expect(readyTimeoutMs({ ANONIFY_READY_TIMEOUT_MS: "500" })).toBe(500)
    expect(() => readyTimeoutMs({ ANONIFY_READY_TIMEOUT_MS: "soon" })).toThrow(
      /ANONIFY_READY_TIMEOUT_MS/
    )
  })
})

describe("GET /api/ready (#167)", () => {
  it("is 200 when the database and storage answer", async () => {
    vi.stubEnv("WORKFLOW_TARGET_WORLD", "")
    const response = await ready()
    expect(response.status).toBe(200)
    expect((await response.json()).status).toBe("ready")
  })

  it("is 503 naming storage when the bucket cannot be reached", async () => {
    vi.stubEnv("WORKFLOW_TARGET_WORLD", "")
    probe.mockRejectedValue(new Error("NoSuchBucket: anonify"))
    const response = await ready()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      status: "not-ready",
      failed: ["storage"],
    })
  })

  it("waits for the workflow worker where this replica runs one", async () => {
    vi.stubEnv("WORKFLOW_TARGET_WORLD", "@workflow/world-postgres")
    expect((await ready()).status).toBe(503)
    clearReadinessCache()
    markWorldStarted()
    expect((await ready()).status).toBe(200)
  })
})
