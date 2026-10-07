import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const query = vi.fn()
const probe = vi.fn()
const uploadMode = vi.fn()
const probeCors = vi.fn()

vi.mock("@/lib/database/prisma", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => query(...args) },
}))
vi.mock("@/lib/storage/blob", () => ({
  probeStorage: () => probe(),
  clientUploadMode: () => uploadMode(),
  probeUploadCors: (origin: string) => probeCors(origin),
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
  uploadMode.mockReset().mockReturnValue("server-route")
  probeCors.mockReset().mockResolvedValue("allowed")
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
    expect(await response.json()).toEqual({ status: "ok", build: "dev" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(query).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })
})

describe("the build a replica runs (#178)", () => {
  it("names the build the image was made from", async () => {
    vi.stubEnv("ANONIFY_BUILD_ID", "v1.15.0-abc1234")
    expect(await health().json()).toEqual({
      status: "ok",
      build: "v1.15.0-abc1234",
    })
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

describe("the health state across bundles (#167)", () => {
  it("is seen by a second copy of the module, as a route sees instrumentation's", async () => {
    // Next.js gives instrumentation.ts and each route its own copy of a
    // module; only the process is shared.
    markWorldStarted()
    vi.resetModules()
    const fresh = await import("@/lib/health/state")
    expect(fresh.healthState().worldStarted).toBe(true)
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

describe("a bucket's CORS behind direct uploads (#185)", () => {
  // The answer is kept for minutes, so each case gets a route of its own,
  // and the refusal is the class that copy of the route knows.
  let CorsRefusal: typeof import("@/lib/storage/cors").CorsRefusal
  async function freshReady() {
    vi.resetModules()
    ;({ CorsRefusal } = await import("@/lib/storage/cors"))
    const { GET } = await import("@/app/api/ready/route")
    const health = await import("@/lib/health/ready")
    // Past the second-long cache of the whole answer, every time.
    return () => {
      health.clearReadinessCache()
      return GET()
    }
  }

  beforeEach(() => {
    vi.stubEnv("WORKFLOW_TARGET_WORLD", "")
    vi.stubEnv("ANONIFY_PUBLIC_URL", "https://redact.example.org/app")
  })

  it("is not checked when browsers upload through the app", async () => {
    const answer = await (await (await freshReady())()).json()
    expect(Object.keys(answer.checks)).not.toContain("presigned-cors")
    expect(probeCors).not.toHaveBeenCalled()
  })

  it("is checked for the public origin when they upload straight to the bucket", async () => {
    uploadMode.mockReturnValue("s3-presigned")
    const answer = await (await (await freshReady())()).json()
    expect(answer.checks).toHaveProperty("presigned-cors")
    expect(probeCors).toHaveBeenCalledWith("https://redact.example.org")
  })

  it("is degraded, not unready, when the rules would refuse a browser", async () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {})
    uploadMode.mockReturnValue("s3-presigned")
    const get = await freshReady()
    probeCors.mockRejectedValue(
      new CorsRefusal(
        "No CORS rule allows the origin https://redact.example.org."
      )
    )
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "ready",
      degraded: ["presigned-cors"],
    })
    const logged = warns.mock.calls.map(([line]) => String(line)).join(" ")
    expect(logged).toContain("No CORS rule allows the origin")
    expect(logged).toContain("fall back to uploading through the app")
  })

  it("asks the bucket again only after a while", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    uploadMode.mockReturnValue("s3-presigned")
    const get = await freshReady()
    probeCors.mockRejectedValue(new CorsRefusal("No CORS rules."))
    await get()
    await get()
    expect(probeCors).toHaveBeenCalledTimes(1)
  })

  it("does not keep a bucket that did not answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    uploadMode.mockReturnValue("s3-presigned")
    probeCors.mockRejectedValueOnce(new Error("socket hang up"))
    const get = await freshReady()
    expect((await (await get()).json()).degraded).toEqual(["presigned-cors"])
    expect((await (await get()).json()).degraded).toBeUndefined()
    expect(probeCors).toHaveBeenCalledTimes(2)
  })

  it("passes, with a note once, when the rules cannot be read", async () => {
    const infos = vi.spyOn(console, "info").mockImplementation(() => {})
    uploadMode.mockReturnValue("s3-presigned")
    probeCors.mockResolvedValue("unreadable")
    const get = await freshReady()
    expect((await get()).status).toBe(200)
    expect(infos).toHaveBeenCalledTimes(1)
    expect(String(infos.mock.calls[0][0])).toContain(
      "upload.presigned-fallback"
    )
  })
})
