import { describe, expect, it } from "vitest"

import { hasDatabase } from "./support"

/**
 * /api/ready against a real Postgres and the local storage driver (#167): the
 * one place the database check runs an actual query.
 */

const { GET } = await import("@/app/api/ready/route")
const { clearReadinessCache } = await import("@/lib/health/ready")

describe.skipIf(!hasDatabase)("readiness against Postgres", () => {
  it("is ready with a database and local storage", async () => {
    delete process.env.WORKFLOW_TARGET_WORLD
    // A running server's client is already connected; a test process's first
    // query also pays for opening the pool, which can outlast the 2s limit.
    const { prisma } = await import("@/lib/database/prisma")
    await prisma.$queryRaw`SELECT 1`
    clearReadinessCache()
    const response = await GET()
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.status).toBe("ready")
    expect(Object.keys(body.checks).sort()).toEqual(["database", "storage"])
  })
})
