import { describe, expect, it } from "vitest"

import { describeWait, rateLimitResponse, readJsonWithin } from "@/lib/api/http"
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

describe("bounded request bodies", () => {
  /** A request with no declared length, the way a chunked upload arrives. */
  function chunked(parts: string[]): {
    request: Request
    pulled: () => number
  } {
    let index = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === parts.length) return controller.close()
        controller.enqueue(new TextEncoder().encode(parts[index++]))
      },
    })
    const request = new Request("http://localhost/api", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit)
    return { request, pulled: () => index }
  }

  it("refuses a body past the limit that declared no length, without reading the rest", async () => {
    const { request, pulled } = chunked([
      '{"messages":["',
      "x".repeat(600),
      "x".repeat(600),
      "x".repeat(600),
      '"]}',
    ])
    expect(request.headers.get("content-length")).toBeNull()

    expect(await readJsonWithin(request, 1_000)).toEqual({ tooLarge: true })
    // Refused on the chunk that crossed the limit; the last was never pulled.
    expect(pulled()).toBeLessThan(5)
  })

  it("refuses a declared length past the limit before reading anything", async () => {
    const request = new Request("http://localhost/api", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "5000" },
    })

    expect(await readJsonWithin(request, 1_000)).toEqual({ tooLarge: true })
    expect(request.bodyUsed).toBe(false)
  })

  it("parses a body within the limit, chunked or not", async () => {
    const { request } = chunked(['{"a":', "[1,2]}"])
    expect(await readJsonWithin(request, 1_000)).toEqual({
      tooLarge: false,
      value: { a: [1, 2] },
    })
  })

  it("treats a malformed or absent body as no value, not as too large", async () => {
    const { request } = chunked(["{not json"])
    expect(await readJsonWithin(request, 1_000)).toEqual({
      tooLarge: false,
      value: undefined,
    })
    expect(
      await readJsonWithin(
        new Request("http://localhost/api", { method: "POST" }),
        1_000
      )
    ).toEqual({ tooLarge: false, value: undefined })
  })
})
