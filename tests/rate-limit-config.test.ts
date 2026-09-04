import { afterEach, describe, expect, it } from "vitest"

import {
  activeProfile,
  defaultsFor,
  envOverrides,
  limitsSchema,
  RATE_LIMIT_NAMES,
  resolveLimits,
} from "@/lib/security/rate-limit-config"

const ENV_KEYS = RATE_LIMIT_NAMES.map(
  (name) => `ANONIFY_RATE_LIMIT_${name.toUpperCase()}`
)

afterEach(() => {
  delete process.env.ANONIFY_PROFILE
  for (const key of ENV_KEYS) delete process.env[key]
})

describe("deployment profiles", () => {
  it("defaults to self-hosted, so a clone is not throttled like a shared demo", () => {
    expect(activeProfile()).toBe("self-hosted")

    process.env.ANONIFY_PROFILE = "demo"
    expect(activeProfile()).toBe("demo")
  })

  it("treats an unrecognised profile as self-hosted", () => {
    process.env.ANONIFY_PROFILE = "staging"
    expect(activeProfile()).toBe("self-hosted")
  })

  it("gives the demo tighter limits than a self-hosted install", () => {
    const demo = defaultsFor("demo")
    const local = defaultsFor("self-hosted")

    for (const name of RATE_LIMIT_NAMES) {
      expect(local[name].limit).toBeGreaterThan(demo[name].limit)
    }
  })

  it("hands out copies, so a caller cannot edit the defaults", () => {
    const first = defaultsFor("demo")
    first.upload.limit = 9999

    expect(defaultsFor("demo").upload.limit).not.toBe(9999)
  })
})

describe("environment overrides", () => {
  it("reads requests/seconds", () => {
    process.env.ANONIFY_RATE_LIMIT_UPLOAD = "100/60"

    expect(envOverrides().upload).toEqual({ limit: 100, windowSeconds: 60 })
  })

  it("ignores whitespace around the separator", () => {
    process.env.ANONIFY_RATE_LIMIT_EXPORT = " 5 / 30 "
    expect(envOverrides().export).toEqual({ limit: 5, windowSeconds: 30 })
  })

  it("reports a malformed value rather than ignoring it", () => {
    // A limit someone believes they set, which is silently not in force, is
    // worse than no setting at all.
    process.env.ANONIFY_RATE_LIMIT_READ = "100 per minute"
    expect(() => envOverrides()).toThrow(/must look like/)
  })

  it("returns nothing when none are set", () => {
    expect(envOverrides()).toEqual({})
  })
})

describe("layering", () => {
  it("applies database over env over defaults", () => {
    const resolved = resolveLimits(
      "demo",
      { upload: { limit: 50, windowSeconds: 60 } },
      { upload: { limit: 5, windowSeconds: 10 } }
    )

    expect(resolved.limits.upload).toEqual({ limit: 5, windowSeconds: 10 })
    expect(resolved.sources.upload).toBe("database")
  })

  it("falls back through the layers per limit, not all or nothing", () => {
    const resolved = resolveLimits(
      "demo",
      { upload: { limit: 50, windowSeconds: 60 } },
      { export: { limit: 2, windowSeconds: 60 } }
    )

    expect(resolved.sources.upload).toBe("env")
    expect(resolved.sources.export).toBe("database")
    expect(resolved.sources.read).toBe("default")
    // Untouched limits keep the profile default.
    expect(resolved.limits.read).toEqual(defaultsFor("demo").read)
  })

  it("reports the profile it resolved against", () => {
    expect(resolveLimits("demo", {}, {}).profile).toBe("demo")
    expect(resolveLimits("self-hosted", {}, {}).limits.upload).toEqual(
      defaultsFor("self-hosted").upload
    )
  })

  it("lets a self-hosted install differ from the demo", () => {
    const demo = resolveLimits("demo", {}, {})
    const selfHosted = resolveLimits(
      "self-hosted",
      {},
      { upload: { limit: 10_000, windowSeconds: 60 } }
    )

    expect(selfHosted.limits.upload.limit).toBeGreaterThan(
      demo.limits.upload.limit
    )
  })
})

describe("the stored override format", () => {
  it("accepts an override for a single limit", () => {
    // `z.record` with enum keys demands every key, so a partial value failed to
    // parse and was swallowed: the CLI reported saving a limit that was never in
    // force. Setting one limit must not mean restating the other three.
    const parsed = limitsSchema.safeParse({
      upload: { limit: 42, windowSeconds: 90 },
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.upload).toEqual({ limit: 42, windowSeconds: 90 })
    }
  })

  it("accepts every limit at once", () => {
    const all = Object.fromEntries(
      RATE_LIMIT_NAMES.map((name) => [name, { limit: 5, windowSeconds: 60 }])
    )

    expect(limitsSchema.safeParse(all).success).toBe(true)
  })

  it("accepts an empty override set", () => {
    expect(limitsSchema.safeParse({}).success).toBe(true)
  })

  it("rejects a value that is not a usable limit", () => {
    expect(
      limitsSchema.safeParse({ upload: { limit: 0, windowSeconds: 60 } }).success
    ).toBe(false)
    expect(
      limitsSchema.safeParse({ upload: { limit: 10 } }).success
    ).toBe(false)
    expect(limitsSchema.safeParse({ nonsense: { limit: 1 } }).success).toBe(false)
  })

  it("round-trips what the CLI writes", () => {
    const written = { upload: { limit: 42, windowSeconds: 90 } }
    const read = limitsSchema.safeParse(JSON.parse(JSON.stringify(written)))

    expect(read.success).toBe(true)
    if (read.success) {
      const resolved = resolveLimits("self-hosted", {}, read.data)
      expect(resolved.sources.upload).toBe("database")
      expect(resolved.limits.upload).toEqual(written.upload)
    }
  })
})
