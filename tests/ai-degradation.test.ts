import { afterEach, describe, expect, it, vi } from "vitest"

import { describeDegradation } from "@/lib/ai/usage-types"

/**
 * Saying that the model pass did less than it meant to.
 *
 * A contextual pass that returned nothing because the provider refused looks,
 * from every angle the reviewer has, exactly like one that genuinely found
 * nothing: the document processes, goes ready, and shows fewer suggestions.
 * Reviewing it as though the model had been asked is the failure this whole
 * codebase exists to prevent, arriving with a clean exit code.
 */

const findFirst = vi.fn()

vi.mock("@/lib/database/prisma", () => ({
  prisma: {
    processingEvent: { findFirst: (...args: unknown[]) => findFirst(...args) },
    aiUsage: { findMany: async () => [] },
  },
}))

const { documentDegradation } = await import("@/lib/ai/usage-report")

afterEach(() => {
  findFirst.mockReset()
})

describe("reading back a degraded pass", () => {
  it("reports the reason and the calls lost", async () => {
    findFirst
      .mockResolvedValueOnce({ at: new Date("2026-09-06T10:00:00Z") })
      .mockResolvedValueOnce({
        type: "document.ai.degraded",
        at: new Date("2026-09-06T10:00:30Z"),
        payload: { reason: "rate-limit", calls: 11 },
      })

    expect(await documentDegradation("doc_1")).toEqual({
      reason: "rate-limit",
      calls: 11,
    })
  })

  it("only looks at the newest run", async () => {
    // A document that failed on a rate limit and was retried into a clean pass
    // must not still be reported as degraded: the event outliving the condition
    // it described is its own kind of lying to the reviewer.
    const startedAt = new Date("2026-09-06T11:00:00Z")
    findFirst.mockResolvedValueOnce({ at: startedAt }).mockResolvedValueOnce(null)

    expect(await documentDegradation("doc_1")).toBeNull()
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: "document.ai.degraded",
          at: { gte: startedAt },
        }),
      })
    )
  })

  it("survives an event written without a usable payload", async () => {
    findFirst
      .mockResolvedValueOnce({ at: new Date() })
      .mockResolvedValueOnce({ type: "document.ai.degraded", payload: null })

    expect(await documentDegradation("doc_1")).toEqual({
      reason: "provider",
      calls: 0,
    })
  })
})

describe("describing it to the reviewer", () => {
  it("names the cause and says what still ran", () => {
    const text = describeDegradation({ reason: "rate-limit", calls: 11 })
    expect(text).toContain("11 model calls")
    expect(text).toContain("rate-limiting")
    // The reassurance matters as much as the warning: the document is not
    // unreviewed, it is reviewed against less.
    expect(text).toContain("Pattern detection ran in full")
  })

  it("reads correctly when the pass never started", () => {
    const text = describeDegradation({ reason: "budget", calls: 0 })
    expect(text).toContain("daily AI spend cap")
    expect(text).not.toContain("0 model calls")
  })

  it("falls back rather than showing a bare reason code", () => {
    expect(describeDegradation({ reason: "something-new", calls: 2 })).toContain(
      "the AI provider failed"
    )
  })
})
