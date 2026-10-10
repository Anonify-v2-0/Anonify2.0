import { afterEach, describe, expect, it, vi } from "vitest"

const adapters = vi.hoisted(() => ({
  pg: [] as unknown[],
  neon: [] as unknown[],
}))

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(config: unknown) {
      adapters.pg.push(config)
    }
  },
}))
vi.mock("@prisma/adapter-neon", () => ({
  PrismaNeon: class {
    constructor(config: unknown) {
      adapters.neon.push(config)
    }
  },
}))
vi.mock("@/lib/database/generated/client", () => ({
  PrismaClient: class {},
}))

const {
  assertWorkflowPoolSettings,
  databasePoolConfig,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  looksLikePooler,
} = await import("@/lib/database/pool-config")

afterEach(() => {
  vi.unstubAllEnvs()
  adapters.pg.length = 0
  adapters.neon.length = 0
  delete (globalThis as { prisma?: unknown }).prisma
})

describe("the database connection budget (#169)", () => {
  it("leaves the driver's pool size alone unless one is set", () => {
    expect(databasePoolConfig({})).toEqual({
      idleTimeoutMillis: DEFAULT_POOL_IDLE_TIMEOUT_MS,
    })
    expect(
      databasePoolConfig({
        DATABASE_POOL_MAX: "5",
        DATABASE_POOL_IDLE_TIMEOUT_MS: "2000",
      })
    ).toEqual({ max: 5, idleTimeoutMillis: 2000 })
  })

  it("refuses a value that looks set and would not be in force", () => {
    expect(() => databasePoolConfig({ DATABASE_POOL_MAX: "abc" })).toThrow(
      /DATABASE_POOL_MAX/
    )
    expect(() => databasePoolConfig({ DATABASE_POOL_MAX: "0" })).toThrow(
      /DATABASE_POOL_MAX/
    )
    expect(() =>
      databasePoolConfig({ DATABASE_POOL_IDLE_TIMEOUT_MS: "soon" })
    ).toThrow(/DATABASE_POOL_IDLE_TIMEOUT_MS/)
    // The world would quietly fall back to its default on these.
    expect(() =>
      assertWorkflowPoolSettings({ WORKFLOW_POSTGRES_MAX_POOL_SIZE: "ten" })
    ).toThrow(/WORKFLOW_POSTGRES_MAX_POOL_SIZE/)
    expect(() =>
      assertWorkflowPoolSettings({ WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "-1" })
    ).toThrow(/WORKFLOW_POSTGRES_WORKER_CONCURRENCY/)
    expect(() =>
      assertWorkflowPoolSettings({
        WORKFLOW_POSTGRES_MAX_POOL_SIZE: "12",
        WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "4",
      })
    ).not.toThrow()
  })

  it("passes the pool size to whichever adapter is chosen", async () => {
    const { getPrisma } = await import("@/lib/database/prisma")
    vi.stubEnv("DATABASE_URL", "postgresql://a:b@localhost:5432/db")
    vi.stubEnv("DATABASE_DRIVER", "postgres")
    vi.stubEnv("DATABASE_POOL_MAX", "5")
    getPrisma()
    // The app makes the node-postgres pool itself now, so its counters can be
    // read for the metrics (#188); the adapter is handed the pool.
    expect((adapters.pg[0] as { options: unknown }).options).toMatchObject({
      connectionString: "postgresql://a:b@localhost:5432/db",
      max: 5,
      idleTimeoutMillis: DEFAULT_POOL_IDLE_TIMEOUT_MS,
    })
    const { appPoolStats } = await import("@/lib/database/prisma")
    expect(appPoolStats()).toEqual({ total: 0, idle: 0, waiting: 0 })

    delete (globalThis as { prisma?: unknown }).prisma
    vi.stubEnv("DATABASE_DRIVER", "neon")
    getPrisma()
    expect(adapters.neon[0]).toMatchObject({ max: 5 })
  })

  it("recognises a transaction pooler the job queue cannot use", () => {
    expect(
      looksLikePooler("postgres://u:p@ep-x-pooler.eu-west-2.aws.neon.tech/db")
    ).toBe(true)
    expect(looksLikePooler("postgres://u:p@pooler.supabase.com:6543/db")).toBe(
      true
    )
    expect(looksLikePooler("postgres://u:p@db.example.org:5432/db")).toBe(false)
    expect(looksLikePooler(undefined)).toBe(false)
  })
})
