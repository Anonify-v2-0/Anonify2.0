import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * The AI Gateway's real ceiling.
 *
 * It meters spend, not requests: there is a credit balance and a budget rather
 * than a requests-per-minute number, so the way an install discovers it has
 * reached the limit is a 402 halfway through somebody's document. Retrying that
 * is pointless and, where the balance tops up automatically, expensive. The
 * only useful answer is a budget the application enforces on itself before the
 * money is spent, which is what these cover.
 */

const aggregate = vi.fn()

vi.mock("@/lib/database/prisma", () => ({
  prisma: { aiUsage: { groupBy: (...args: unknown[]) => aggregate(...args) } },
}))

const { spendAllows, spendStatus, spentTodayUsd, startOfUtcDay } =
  await import("@/lib/ai/spend")
const { throttleState, resetThrottles } =
  await import("@/lib/services/throttle")
const { SPEND_ENV_NAME } = await import("@/lib/services/limits")

/** $1 per million in and $2 per million out makes the arithmetic legible. */
function pricesAre(): void {
  process.env.AI_PRICE_INPUT_PER_MTOK = "1"
  process.env.AI_PRICE_OUTPUT_PER_MTOK = "2"
}

function spent(inputTokens: number, outputTokens: number): void {
  aggregate.mockResolvedValue([
    {
      model: "anthropic/claude-haiku-4.5",
      _sum: { inputTokens, outputTokens },
    },
  ])
}

afterEach(() => {
  for (const key of [
    SPEND_ENV_NAME,
    "AI_PRICE_INPUT_PER_MTOK",
    "AI_PRICE_OUTPUT_PER_MTOK",
    "AI_PROVIDER",
    "AI_MODEL_PRICES",
  ]) {
    delete process.env[key]
  }
  aggregate.mockReset()
  resetThrottles()
})

describe("what has been spent today", () => {
  it("counts from midnight UTC, matching how daily quotas are counted", async () => {
    pricesAre()
    spent(1_000_000, 500_000)

    const now = new Date("2026-09-06T13:45:00Z")
    await spentTodayUsd(now)

    expect(startOfUtcDay(now).toISOString()).toBe("2026-09-06T00:00:00.000Z")
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { gte: startOfUtcDay(now) } },
      })
    )
  })

  it("is null without prices, because a cost cannot be invented", async () => {
    spent(1_000_000, 1_000_000)
    expect(await spentTodayUsd()).toBeNull()
    // Not even queried: there is nothing to compute from.
    expect(aggregate).not.toHaveBeenCalled()
  })

  it("estimates from the configured rates", async () => {
    pricesAre()
    spent(2_000_000, 1_000_000)
    expect(await spentTodayUsd()).toBeCloseTo(4)
  })
})

describe("the cap", () => {
  it("does not meter local Ollama calls or query hosted spend", async () => {
    process.env.AI_PROVIDER = "ollama"
    process.env[SPEND_ENV_NAME] = "1"
    expect(await spendStatus()).toEqual({ state: "uncapped", reason: "local" })
    expect(aggregate).not.toHaveBeenCalled()
  })

  it("sums historical models at their own configured rates", async () => {
    process.env.AI_MODEL_PRICES = JSON.stringify({
      "anthropic/claude-haiku-4.5": { inputPerMillion: 1, outputPerMillion: 2 },
      "openai:other": { inputPerMillion: 10, outputPerMillion: 20 },
    })
    aggregate.mockResolvedValue([
      {
        model: "anthropic/claude-haiku-4.5",
        _sum: { inputTokens: 1_000_000, outputTokens: 0 },
      },
      {
        model: "openai:other",
        _sum: { inputTokens: 1_000_000, outputTokens: 0 },
      },
    ])
    expect(await spentTodayUsd()).toBe(11)
  })
  it("is absent by default, and lifts any ceiling it had set", async () => {
    const status = await spendStatus()
    expect(status.state).toBe("uncapped")
    expect(spendAllows(status)).toBe(true)
    expect(throttleState("ai").ceiling).toBeNull()
  })

  it("cannot be enforced without prices, and says so rather than stopping work", async () => {
    // Stopping a redaction for a number that was never computed would be the
    // worse of the two failures by a distance.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env[SPEND_ENV_NAME] = "5"

    const status = await spendStatus()

    expect(status).toEqual({ state: "uncapped", reason: "no-prices" })
    expect(spendAllows(status)).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("runs at full speed while there is room", async () => {
    pricesAre()
    process.env[SPEND_ENV_NAME] = "10"
    spent(1_000_000, 0)

    const status = await spendStatus()

    expect(status.state).toBe("under")
    expect(throttleState("ai").ceiling).toBeNull()
  })

  it("drops to one call at a time at 80%", async () => {
    // A cap that only acts at 100% is a cliff, and the document that walks off
    // it is one halfway through review.
    pricesAre()
    process.env[SPEND_ENV_NAME] = "10"
    spent(8_000_000, 0)

    const status = await spendStatus()

    expect(status.state).toBe("slowing")
    expect(spendAllows(status)).toBe(true)
    expect(throttleState("ai").ceiling).toBe(1)
  })

  it("stops the contextual pass at the cap", async () => {
    pricesAre()
    process.env[SPEND_ENV_NAME] = "10"
    spent(10_000_000, 0)

    const status = await spendStatus()

    expect(status.state).toBe("exhausted")
    expect(spendAllows(status)).toBe(false)
  })
})
