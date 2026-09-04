import { describe, expect, it } from "vitest"

import {
  bucketFor,
  consume,
  freshState,
  refill,
  type BucketState,
} from "@/lib/security/token-bucket"

const CONFIG = bucketFor(10, 60) // 10 requests per minute

function at(secondsFromStart: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + secondsFromStart * 1000)
}

/** Spends `count` requests in a row at one instant. */
function spend(state: BucketState, count: number, now: Date) {
  let current = state
  let allowed = 0
  for (let i = 0; i < count; i++) {
    const decision = consume(current, CONFIG, now)
    current = decision.state
    if (decision.allowed) allowed += 1
  }
  return { state: current, allowed }
}

describe("token bucket", () => {
  it("starts full and allows a burst up to the limit", () => {
    const { allowed } = spend(freshState(CONFIG, at(0)), 10, at(0))
    expect(allowed).toBe(10)
  })

  it("refuses once the bucket is empty", () => {
    const { state } = spend(freshState(CONFIG, at(0)), 10, at(0))
    const decision = consume(state, CONFIG, at(0))

    expect(decision.allowed).toBe(false)
    expect(decision.remaining).toBe(0)
  })

  it("closes the window-boundary burst a fixed window allows", () => {
    // A fixed window would permit 10 at the end of one window and 10 at the
    // start of the next — 20 within a moment of each other.
    const first = spend(freshState(CONFIG, at(0)), 10, at(59))
    const second = spend(first.state, 10, at(61))

    expect(first.allowed).toBe(10)
    // Two seconds of refill at 10/60 per second is a third of a token.
    expect(second.allowed).toBe(0)
  })

  it("refills continuously rather than in steps", () => {
    const { state } = spend(freshState(CONFIG, at(0)), 10, at(0))

    // Six seconds is exactly one token at 10 per 60s.
    expect(consume(state, CONFIG, at(5)).allowed).toBe(false)
    expect(consume(state, CONFIG, at(6)).allowed).toBe(true)
  })

  it("never accumulates more than the burst", () => {
    const idle: BucketState = { tokens: 0, updatedAt: at(0) }
    // An hour of refill on a ten-token bucket is still ten tokens.
    expect(refill(idle, CONFIG, at(3600))).toBe(10)
  })

  it("tells a refused caller when to come back", () => {
    const { state } = spend(freshState(CONFIG, at(0)), 10, at(0))
    const decision = consume(state, CONFIG, at(0))

    // One token at 10/60 per second is six seconds.
    expect(decision.retryAfterMs).toBe(6000)
  })

  it("keeps the refill clock advancing on a refusal", () => {
    const { state } = spend(freshState(CONFIG, at(0)), 10, at(0))

    const refused = consume(state, CONFIG, at(3))
    expect(refused.allowed).toBe(false)
    expect(refused.state.updatedAt).toEqual(at(3))

    // The three seconds already elapsed still count towards the next token.
    expect(consume(refused.state, CONFIG, at(6)).allowed).toBe(true)
  })

  it("sustains the configured long-run rate", () => {
    let state = freshState(CONFIG, at(0))
    let allowed = 0

    // One request every two seconds for five minutes: 150 attempts against a
    // sustained allowance of 10/minute plus the initial burst of 10.
    for (let second = 0; second < 300; second += 2) {
      const decision = consume(state, CONFIG, at(second))
      state = decision.state
      if (decision.allowed) allowed += 1
    }

    expect(allowed).toBeGreaterThanOrEqual(50)
    expect(allowed).toBeLessThanOrEqual(60)
  })

  it("does not go negative when refused repeatedly", () => {
    const { state } = spend(freshState(CONFIG, at(0)), 10, at(0))
    const hammered = spend(state, 50, at(0))

    expect(hammered.allowed).toBe(0)
    expect(hammered.state.tokens).toBeGreaterThanOrEqual(0)
  })

  it("treats a clock that moves backwards as no elapsed time", () => {
    const state: BucketState = { tokens: 2, updatedAt: at(100) }
    expect(refill(state, CONFIG, at(50))).toBe(2)
  })
})
