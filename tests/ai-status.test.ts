import { randomBytes } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `pnpm ai status` for a ChatGPT sign-in: who, which plan, how much of the
 * plan is used, and what this instance has sent. OpenAI's side is a fake
 * shaped like Codex's own types (codex-rs: token_data.rs for the claims,
 * RateLimitStatusPayload for /wham/usage); ours is the real code.
 */

const settings = new Map<string, unknown>()
const groupBy = vi.fn()
vi.mock("@/lib/database/prisma", () => ({
  prisma: {
    aiUsage: { groupBy: (...args: unknown[]) => groupBy(...args) },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.has(where.key)
          ? { key: where.key, value: settings.get(where.key) }
          : null,
      upsert: async ({
        where,
        create,
      }: {
        where: { key: string }
        create: { value: unknown }
      }) => {
        settings.set(where.key, structuredClone(create.value))
      },
    },
  },
}))

const {
  exchangeCode,
  fetchSubscriptionUsage,
  loadLogin,
  parseUsage,
  planName,
  profileOf,
  saveLogin,
} = await import("@/lib/ai/providers/subscription")
const { providerUsage } = await import("@/lib/ai/usage-report")
const {
  accountLines,
  bar,
  instanceUsageLines,
  masked,
  planUsageLines,
  until,
  windowLabel,
} = await import("../scripts/ai-status")

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "none" })}.${part(payload)}.signature`
}

const ID_TOKEN = jwt({
  email: "operator@example.org",
  "https://api.openai.com/auth": {
    chatgpt_plan_type: "plus",
    chatgpt_user_id: "user-fixture",
    chatgpt_account_id: "acct_0123456789abcdef",
  },
})

/** What /wham/usage answers, in Codex's RateLimitStatusPayload shape. */
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0)
const USAGE = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 35,
      limit_window_seconds: 18_000,
      reset_after_seconds: 7_800,
      reset_at: NOW / 1000 + 7_800,
    },
    secondary_window: {
      used_percent: 92,
      limit_window_seconds: 604_800,
      reset_after_seconds: 259_200,
      reset_at: NOW / 1000 + 259_200,
    },
  },
  credits: { has_credits: true, unlimited: false, balance: "12.50" },
  additional_rate_limits: [
    {
      limit_name: "GPT-5 Codex Spark",
      metered_feature: "codex_spark",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 5,
          limit_window_seconds: 18_000,
          reset_after_seconds: 100,
          reset_at: NOW / 1000 + 100,
        },
      },
    },
  ],
  account_id: "acct_0123456789abcdef",
  user_id: "user-fixture",
}

beforeEach(() => {
  settings.clear()
  groupBy.mockReset()
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("who is signed in, and on which plan", () => {
  it("reads the account from the ID token's claims, as Codex does", () => {
    expect(profileOf(ID_TOKEN)).toEqual({
      email: "operator@example.org",
      plan: "plus",
      userId: "user-fixture",
    })
    // The email can also sit under the profile claim.
    expect(
      profileOf(jwt({ "https://api.openai.com/profile": { email: "p@example.org" } }))
    ).toEqual({ email: "p@example.org" })
    expect(profileOf("not-a-jwt", undefined)).toBeUndefined()
  })

  it("falls back to the access token, so a sign-in stored before this still answers", () => {
    expect(profileOf(undefined, ID_TOKEN)?.plan).toBe("plus")
  })

  it("keeps the account with the sealed sign-in, and through a refresh that omits it", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: ID_TOKEN,
        expires_in: 3600,
      })
    )
    const login = await exchangeCode("code", "verifier", fetcher)
    expect(login.profile).toEqual({
      email: "operator@example.org",
      plan: "plus",
      userId: "user-fixture",
    })
    await saveLogin(login)
    expect((await loadLogin())?.profile?.email).toBe("operator@example.org")
    // Sealed like the tokens: not readable in the stored row.
    expect(JSON.stringify([...settings.values()])).not.toContain("operator@")
  })

  it("names plans the way Codex CLI does, and shows one it does not know as sent", () => {
    expect(planName("plus")).toBe("Plus")
    expect(planName("prolite")).toBe("Pro")
    expect(planName("promax")).toBe("Pro (Max)")
    expect(planName("ent26")).toBe("Enterprise")
    expect(planName("brand_new_plan")).toBe("brand_new_plan")
  })
})

describe("the plan's usage, from OpenAI", () => {
  it("asks the endpoint Codex's /status uses, as the signed-in workspace", async () => {
    await saveLogin({
      access: "access-live",
      refresh: "refresh-live",
      expiresAt: Date.now() + 3_600_000,
      accountId: "acct_0123456789abcdef",
    })
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(USAGE))

    const usage = await fetchSubscriptionUsage(fetcher)

    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer access-live")
    expect(headers.get("chatgpt-account-id")).toBe("acct_0123456789abcdef")
    expect(usage).toMatchObject({
      plan: "pro",
      allowed: true,
      limitReached: false,
      windows: [
        { usedPercent: 35, windowSeconds: 18_000, resetsAt: NOW + 7_800_000 },
        { usedPercent: 92, windowSeconds: 604_800, resetsAt: NOW + 259_200_000 },
      ],
      credits: { hasCredits: true, unlimited: false, balance: "12.50" },
      additional: [{ name: "GPT-5 Codex Spark", limitReached: false }],
    })
  })

  it("says to sign in again when OpenAI refuses, and quotes nothing it said", async () => {
    await saveLogin({
      access: "access-live",
      refresh: "refresh-live",
      expiresAt: Date.now() + 3_600_000,
    })
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("token access-live is invalid", { status: 401 })
    )
    const error = await fetchSubscriptionUsage(fetcher).catch((caught) => caught)
    expect(error.name).toBe("UsageError")
    expect(error.message).toContain("pnpm ai login --provider openai")
    expect(error.message).not.toContain("access-live")
  })

  it("leaves out what the answer does not carry, rather than guessing", () => {
    expect(parseUsage({})).toEqual({ windows: [], additional: [] })
    expect(
      parseUsage({ rate_limit: { primary_window: { used_percent: "lots" } } })
        .windows
    ).toEqual([])
    // A percentage is kept within 0 to 100.
    expect(
      parseUsage({
        rate_limit: {
          primary_window: { used_percent: 140, limit_window_seconds: 60 },
        },
      }).windows[0].usedPercent
    ).toBe(100)
  })
})

describe("what status prints", () => {
  it("names windows the way Codex CLI does", () => {
    expect(windowLabel(18_000)).toBe("5-hour limit")
    expect(windowLabel(604_800)).toBe("Weekly limit")
    expect(windowLabel(86_400)).toBe("Daily limit")
    expect(windowLabel(2_592_000)).toBe("30-day limit")
    expect(windowLabel(900)).toBe("15-minute limit")
  })

  it("says when a window resets, relative to now", () => {
    expect(until(NOW + 20 * 60_000, NOW)).toBe("in 20 min")
    expect(until(NOW + 130 * 60_000, NOW)).toBe("in 2 h 10 min")
    expect(until(NOW + 3 * 86_400_000, NOW)).toBe("in 3 days")
    expect(until(NOW - 1, NOW)).toBe("now")
  })

  it("draws a bar, and shortens IDs", () => {
    expect(bar(35)).toBe(`${"█".repeat(7)}${"░".repeat(13)}`)
    expect(bar(0)).toBe("░".repeat(20))
    expect(bar(250)).toBe("█".repeat(20))
    expect(masked("acct_0123456789abcdef")).toBe("…abcdef")
  })

  it("shows the account, preferring the plan OpenAI reports now", () => {
    const lines = accountLines(
      {
        expiresAt: NOW + 52 * 60_000,
        accountId: "acct_0123456789abcdef",
        profile: { email: "operator@example.org", plan: "plus" },
      },
      NOW,
      "pro"
    ).map((line) => line.text)
    expect(lines).toEqual([
      "ChatGPT account",
      "Signed in as   operator@example.org",
      "Plan           Pro (More)",
      "Workspace      …abcdef",
      "Access token   expires in 52 min; refreshed on use",
    ])
  })

  it("shows each limit with its bar, warns near the top, and says when it is reached", () => {
    const lines = planUsageLines(parseUsage(USAGE), NOW)
    const text = lines.map((line) => line.text)
    expect(text[0]).toBe("Plan usage (from OpenAI)")
    expect(text[1]).toBe(`5-hour limit   ${bar(35)} 35% used · resets in 2 h 10 min`)
    expect(lines[2]).toEqual({
      level: "warn",
      text: `Weekly limit   ${bar(92)} 92% used · resets in 3 days`,
    })
    expect(text).toContain("GPT-5 Codex Spark:")
    expect(text).toContain("Credits        balance 12.50")

    const reached = planUsageLines(
      parseUsage({
        ...USAGE,
        rate_limit: { ...USAGE.rate_limit, allowed: false, limit_reached: true },
        rate_limit_reached_type: { type: "rate_limit_reached" },
      }),
      NOW
    )
    expect(reached.at(-1)).toMatchObject({
      level: "warn",
      text: expect.stringContaining("limit is reached (rate limit reached)"),
    })
  })

  it("sums this instance's calls today and all time, per model", () => {
    const lines = instanceUsageLines(
      {
        today: [
          { model: "openai-subscription:a", calls: 3, inputTokens: 12_000, outputTokens: 900 },
        ],
        allTime: [
          { model: "openai-subscription:a", calls: 40, inputTokens: 1_500_000, outputTokens: 20_000 },
          { model: "openai-subscription:b", calls: 2, inputTokens: 800, outputTokens: 100 },
        ],
        estimatedTodayUsd: 0,
        estimatedAllTimeUsd: null,
      },
      "openai-subscription"
    ).map((line) => line.text)
    expect(lines).toEqual([
      "Usage by this instance (openai-subscription)",
      "Today (UTC)    3 calls · 12K tokens in · 900 out",
      "All time       42 calls · 1.5M tokens in · 20K out · cost unknown (no price for some model)",
      "  openai-subscription:a: 40 calls · 1.5M in · 20K out",
      "  openai-subscription:b: 2 calls · 800 in · 100 out",
    ])
  })
})

describe("usage by this instance", () => {
  it("counts one provider's rows, today and all time, from the usage table", async () => {
    groupBy.mockImplementation(async (query: { where: { createdAt?: unknown } }) =>
      query.where.createdAt
        ? [
            {
              model: "openai-subscription:a",
              _count: { _all: 2 },
              _sum: { inputTokens: 100, outputTokens: 10 },
            },
          ]
        : [
            {
              model: "openai-subscription:a",
              _count: { _all: 9 },
              _sum: { inputTokens: 900, outputTokens: 90 },
            },
          ]
    )

    const usage = await providerUsage("openai-subscription", new Date(NOW))

    const [today, all] = groupBy.mock.calls.map(([query]) => query)
    expect(today.where).toEqual({
      model: { startsWith: "openai-subscription:" },
      createdAt: { gte: new Date(Date.UTC(2026, 8, 27)) },
    })
    expect(all.where).toEqual({ model: { startsWith: "openai-subscription:" } })
    expect(usage.today).toEqual([
      { model: "openai-subscription:a", calls: 2, inputTokens: 100, outputTokens: 10 },
    ])
    expect(usage.allTime[0].calls).toBe(9)
    // A flat subscription with no recorded price costs $0.
    expect(usage.estimatedAllTimeUsd).toBe(0)
  })

  it("keeps Gateway's unprefixed rows apart from every other provider's", async () => {
    groupBy.mockResolvedValue([])
    await providerUsage("gateway", new Date(NOW))
    expect(groupBy.mock.calls[0][0].where.model).toEqual({
      not: { contains: ":" },
    })
  })
})
