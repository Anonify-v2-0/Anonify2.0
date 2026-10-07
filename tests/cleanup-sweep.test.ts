import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * The expiry sweep's handling of a document it cannot purge. Against a
 * database, tests/integration/cleanup.integration.test.ts covers the race
 * that used to fail it; this covers the rule that one bad document must not
 * cost the rest of the page their deletion.
 */

const findMany = vi.fn()
vi.mock("@/lib/database/prisma", () => ({
  prisma: { document: { findMany: (...args: unknown[]) => findMany(...args) } },
}))
const purgeDocument = vi.fn()
vi.mock("@/lib/documents/purge", () => ({
  PURGE_SELECT: {},
  purgeDocument: (...args: unknown[]) => purgeDocument(...args),
}))
vi.mock("@/lib/documents/batches", () => ({ pruneEmptyBatches: async () => 0 }))
// The lock is Postgres's; tests/integration/cleanup.integration.test.ts has it.
vi.mock("@/lib/database/locks", () => ({
  withAdvisoryLock: async (
    _name: string,
    _hold: number,
    work: () => unknown
  ) => ({
    acquired: true,
    result: await work(),
  }),
}))
vi.mock("@/lib/security/rate-limit", () => ({ pruneRateLimits: async () => 0 }))

const { cleanupExpired } = await import("@/lib/workflows/cleanup")

afterEach(() => {
  vi.restoreAllMocks()
  findMany.mockReset()
  purgeDocument.mockReset()
})

describe("the expiry sweep", () => {
  it("carries on past a document that throws, and counts it", async () => {
    findMany.mockResolvedValue([{ id: "doc_bad" }, { id: "doc_good" }])
    purgeDocument.mockImplementation(async (document: { id: string }) => {
      if (document.id === "doc_bad") throw new Error("database hiccup")
      return {
        objectsDeleted: 3,
        storageCleared: true,
        recordDeleted: true,
        deletedIds: [document.id],
      }
    })
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})

    const result = await cleanupExpired()

    expect(result).toMatchObject({
      documentsDeleted: 1,
      objectsDeleted: 3,
      failures: 1,
    })
    expect(purgeDocument).toHaveBeenCalledTimes(2)
    // Which document, and what kind of failure; never the error's text.
    const line = JSON.parse(String(logged.mock.calls[0][0]))
    expect(line).toEqual({
      level: "error",
      context: "cleanup.document",
      documentId: "doc_bad",
      errorCategory: "unexpected",
    })
    expect(JSON.stringify(logged.mock.calls)).not.toContain("hiccup")
  })
})
