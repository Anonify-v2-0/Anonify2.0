import { describe, expect, it } from "vitest"

import { describeWait, rateLimitResponse } from "@/lib/api/http"
import { readFailure } from "@/lib/api/errors"
import { usedFraction } from "@/types/limits"

/**
 * Being refused is a normal outcome, not an error page. What makes it usable is
 * the one fact the server has and the client was throwing away: how long to
 * wait. These cover the round trip of that fact.
 */

describe("rate limit responses", () => {
  it("says how long to wait, in the body and the header", async () => {
    const response = rateLimitResponse(
      { resetAt: new Date(Date.now() + 42_000) },
      "uploads"
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("42")

    const payload = (await response.json()) as {
      error: string
      retryAfterSeconds: number
      rateLimited: boolean
    }
    expect(payload.error).toBe("Too many uploads. Try again in 42 seconds.")
    expect(payload.retryAfterSeconds).toBe(42)
    expect(payload.rateLimited).toBe(true)
  })

  it("never tells someone to wait zero seconds", () => {
    const response = rateLimitResponse({ resetAt: new Date(Date.now() - 5) }, "reads")
    expect(response.headers.get("retry-after")).toBe("1")
  })

  it("scales the wording with the wait", () => {
    expect(describeWait(1)).toBe("1 second")
    expect(describeWait(45)).toBe("45 seconds")
    expect(describeWait(90)).toBe("2 minutes")
    expect(describeWait(7200)).toBe("2 hours")
  })
})

describe("reading a failure on the client", () => {
  it("keeps the server's sentence rather than a generic one", async () => {
    const failure = await readFailure(
      rateLimitResponse({ resetAt: new Date(Date.now() + 30_000) }, "exports"),
      "The export could not be generated."
    )

    expect(failure.message).toBe("Too many exports. Try again in 30 seconds.")
    expect(failure.rateLimited).toBe(true)
    expect(failure.retryAfterSeconds).toBe(30)
  })

  it("falls back when the response carries nothing useful", async () => {
    const failure = await readFailure(
      new Response("<html>gateway timeout</html>", { status: 504 }),
      "That change could not be saved."
    )

    expect(failure.message).toBe("That change could not be saved.")
    expect(failure.rateLimited).toBe(false)
  })

  it("treats any 429 as rate limited, whatever the body says", async () => {
    const failure = await readFailure(
      Response.json({ error: "Slow down" }, { status: 429 }),
      "fallback"
    )

    expect(failure.rateLimited).toBe(true)
    expect(failure.message).toBe("Slow down")
  })
})

describe("allowance arithmetic", () => {
  it("reports a share of a real limit", () => {
    expect(usedFraction(0, 10)).toBe(0)
    expect(usedFraction(3, 10)).toBeCloseTo(0.3)
  })

  it("has no share to report for an unlimited allowance", () => {
    // Self-hosted quotas are 0, meaning unlimited. A bar drawn from that would
    // read as "completely full" or "completely empty", both of them lies.
    expect(usedFraction(500, 0)).toBeNull()
  })

  it("does not exceed the whole when an overrun is recorded", () => {
    // Page counts are charged after extraction, so usage can land above the
    // limit; the meter should sit at full rather than overflow its track.
    expect(usedFraction(14, 10)).toBe(1)
  })
})
