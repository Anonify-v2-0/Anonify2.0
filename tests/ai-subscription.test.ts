import { createHash, randomBytes } from "node:crypto"

import { generateText, isStepCount, Output, streamText, tool } from "ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { providerConfigured, selectedProvider } from "@/lib/ai/providers"
import { capabilityDeclaration } from "@/lib/ai/providers/config"
import { estimateRows, ratesFor } from "@/lib/ai/rates"
import { classifyServiceError, resetThrottles } from "@/lib/services/throttle"
import { canOpenBrowser, startCallbackServer } from "../scripts/ai-login"
import { codexStream } from "./helpers/codex-stream"

/** The settings table, in memory: the only rows these tests read or write. */
const settings = new Map<string, unknown>()
const usageCreate = vi.fn()
vi.mock("@/lib/database/prisma", () => ({
  prisma: {
    aiUsage: { create: (...args: unknown[]) => usageCreate(...args) },
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
      deleteMany: async ({ where }: { where: { key: string } }) => {
        const had = settings.delete(where.key)
        return { count: had ? 1 : 0 }
      },
    },
  },
}))

const subscription = await import("@/lib/ai/providers/subscription")
const { runStructured } = await import("@/lib/ai/gateway")
const {
  accountIdOf,
  authorizeUrl,
  codeFromRedirect,
  currentLogin,
  deleteLogin,
  exchangeCode,
  fromCodexStream,
  loadLogin,
  LOGIN_SETTING_KEY,
  newPkce,
  saveLogin,
  SubscriptionAuthError,
  subscriptionModel,
  toCodexRequest,
} = subscription

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "none" })}.${part(payload)}.signature`
}

const ACCOUNT_CLAIMS = {
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" },
}

beforeEach(() => {
  settings.clear()
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetThrottles()
  usageCreate.mockReset()
})

describe("the authorization request", () => {
  it("uses PKCE with S256 and a fresh state, on Codex's registered redirect", () => {
    const pkce = newPkce()
    expect(pkce.challenge).toBe(
      createHash("sha256").update(pkce.verifier).digest("base64url")
    )
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(newPkce().state).not.toBe(pkce.state)

    const url = new URL(authorizeUrl(pkce))
    expect(url.origin + url.pathname).toBe(
      "https://auth.openai.com/oauth/authorize"
    )
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirect_uri: "http://localhost:1455/auth/callback",
      scope: "openid profile email offline_access",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: pkce.state,
      originator: "anonify",
    })
    // The verifier is the one secret the request must never carry.
    expect(url.toString()).not.toContain(pkce.verifier)
  })

  it("takes the code from a pasted address or a callback query, and only for its own state", () => {
    const state = "state-fixture"
    expect(
      codeFromRedirect(
        `http://localhost:1455/auth/callback?code=the-code&state=${state}`,
        state
      )
    ).toBe("the-code")
    expect(codeFromRedirect(`?code=the-code&state=${state}`, state)).toBe(
      "the-code"
    )
    expect(codeFromRedirect(`  code=the-code&state=${state}\n`, state)).toBe(
      "the-code"
    )

    const refusal = (input: string) => {
      try {
        codeFromRedirect(input, state)
      } catch (error) {
        return (error as Error).message
      }
      throw new Error("accepted")
    }
    const forged = refusal(
      "http://localhost:1455/auth/callback?code=stolen&state=other"
    )
    expect(forged).toContain("not from this sign-in attempt")
    for (const secret of ["stolen", "other", state])
      expect(forged).not.toContain(secret)
    expect(refusal(`?state=${state}`)).toContain("no authorization code")
    expect(refusal("?error=access_denied")).toBe(
      "The sign-in was refused (access_denied)."
    )
    expect(refusal("?error=%3Cscript%3E")).toBe("The sign-in was refused.")
  })
})

describe("tokens", () => {
  it("exchanges the code as a form, and reads expiry and workspace from the answer", async () => {
    let sent: URLSearchParams | undefined
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://auth.openai.com/oauth/token")
      sent = init?.body as URLSearchParams
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: jwt(ACCOUNT_CLAIMS),
        expires_in: 3600,
      })
    })
    const login = await exchangeCode("the-code", "the-verifier", fetcher, 1_000)
    expect(Object.fromEntries(sent!)).toEqual({
      grant_type: "authorization_code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: "the-code",
      code_verifier: "the-verifier",
      redirect_uri: "http://localhost:1455/auth/callback",
    })
    expect(login).toEqual({
      access: "access-1",
      refresh: "refresh-1",
      expiresAt: 1_000 + 3_600_000,
      accountId: "acct_fixture",
    })
  })

  it("finds the workspace in either token, and falls back to the organization", () => {
    expect(accountIdOf(undefined, jwt({ chatgpt_account_id: "top" }))).toBe(
      "top"
    )
    expect(accountIdOf(jwt({ organizations: [{ id: "org_1" }] }))).toBe("org_1")
    expect(accountIdOf("not-a-jwt", undefined)).toBeUndefined()
  })

  it("never repeats what the issuer said when it refuses", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('{"error":"invalid_grant","code":"the-code"}', {
          status: 400,
        })
    )
    const error: Error = await exchangeCode("the-code", "v", fetcher).then(
      () => {
        throw new Error("accepted")
      },
      (caught: Error) => caught
    )
    expect(error.message).toBe(
      "The OpenAI sign-in service refused the request (HTTP 400)."
    )
    expect(error.message).not.toContain("the-code")
  })
})

describe("the sealed store", () => {
  const login = {
    access: "access-secret",
    refresh: "refresh-secret",
    expiresAt: Date.now() + 3_600_000,
    accountId: "acct_fixture",
  }

  it("keeps the token sealed in one Setting row, and deletes it on logout", async () => {
    await saveLogin(login)
    const stored = JSON.stringify(settings.get(LOGIN_SETTING_KEY))
    expect(stored).not.toContain("access-secret")
    expect(stored).not.toContain("refresh-secret")
    expect(stored).not.toContain("acct_fixture")
    expect(await loadLogin()).toEqual(login)

    expect(await deleteLogin()).toBe(true)
    expect(await loadLogin()).toBeNull()
    expect(await deleteLogin()).toBe(false)
  })

  it("says a different ENCRYPTION_KEY cannot open it, rather than 'not signed in'", async () => {
    await saveLogin(login)
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"))
    await expect(loadLogin()).rejects.toThrow(
      "cannot be opened with this ENCRYPTION_KEY"
    )
  })
})

describe("refresh on use", () => {
  const expiring = (refresh = "refresh-1") => ({
    access: "access-old",
    refresh,
    expiresAt: 10_000 + 30_000,
    accountId: "acct_fixture",
  })
  const now = () => 10_000

  it("returns a token with time left, without asking the issuer", async () => {
    await saveLogin({ ...expiring(), expiresAt: 10_000 + 600_000 })
    const fetcher = vi.fn<typeof fetch>()
    expect((await currentLogin(fetcher, now)).access).toBe("access-old")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("refreshes one about to expire once, however many calls want it, and writes it back", async () => {
    await saveLogin(expiring())
    const fetcher = vi.fn<typeof fetch>(async (_, init) => {
      const body = Object.fromEntries(init?.body as URLSearchParams)
      expect(body).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      return Response.json({
        access_token: "access-new",
        refresh_token: "refresh-2",
        expires_in: 3600,
      })
    })
    const [first, second] = await Promise.all([
      currentLogin(fetcher, now),
      currentLogin(fetcher, now),
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(first.access).toBe("access-new")
    expect(second.access).toBe("access-new")
    // The workspace survives a refresh that does not repeat it.
    expect(await loadLogin()).toMatchObject({
      access: "access-new",
      refresh: "refresh-2",
      accountId: "acct_fixture",
    })
  })

  it("uses a token another process already rotated, rather than failing", async () => {
    await saveLogin(expiring())
    const fetcher = vi.fn<typeof fetch>(async () => {
      // The app refreshed first; our refresh token is now spent.
      await saveLogin({
        ...expiring("refresh-rotated"),
        access: "access-theirs",
      })
      return new Response("", { status: 400 })
    })
    expect((await currentLogin(fetcher, now)).access).toBe("access-theirs")
  })

  it("reports a revoked sign-in as an authorization failure, which is not retried", async () => {
    await saveLogin(expiring())
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("", { status: 401 })
    )
    const error = await currentLogin(fetcher, now).catch((caught) => caught)
    expect(error).toBeInstanceOf(SubscriptionAuthError)
    expect(error.message).toContain("pnpm ai login --provider openai")
    expect(classifyServiceError(error)).toMatchObject({
      kind: "authorization",
      retryable: false,
    })
  })
})

describe("the Codex transport", () => {
  it("moves system messages into instructions, stores nothing and streams", () => {
    const request = toCodexRequest({
      model: "m",
      input: [
        { role: "system", content: "Find personal data." },
        {
          role: "developer",
          content: [{ type: "input_text", text: "Be terse." }],
        },
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
      max_output_tokens: 100,
      store: true,
    })
    expect(request).toEqual({
      model: "m",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
      instructions: "Find personal data.\n\nBe terse.",
      store: false,
      stream: true,
    })
    expect(toCodexRequest({ input: [] }).instructions).toBeTruthy()
  })

  it("puts back the answer the real backend streams but leaves out of response.completed", async () => {
    const collected = await fromCodexStream(
      codexStream("gpt-fixture", '{"answer":5}', { input: 18, output: 8 })
    )
    const response = await collected.json()
    expect(response.output).toEqual([
      {
        id: "msg_fixture",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", annotations: [], text: '{"answer":5}' },
        ],
      },
    ])
    expect(response.usage).toMatchObject({ input_tokens: 18, output_tokens: 8 })
  })

  it("collects the stream into the completed response, and turns anything else into a 502", async () => {
    const completed = { id: "resp_1", output: [], usage: { input_tokens: 1 } }
    const stream = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created" })}`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}`,
      "",
    ].join("\n\n")
    const collected = await fromCodexStream(new Response(stream))
    expect(collected.status).toBe(200)
    expect(await collected.json()).toEqual(completed)

    const failed = await fromCodexStream(
      new Response(`data: ${JSON.stringify({ type: "response.failed" })}\n\n`)
    )
    expect(failed.status).toBe(502)
  })

  it("carries a structured call and an image end to end, as the signed-in workspace", async () => {
    await saveLogin({
      access: "access-live",
      refresh: "refresh-live",
      expiresAt: Date.now() + 3_600_000,
      accountId: "acct_fixture",
    })
    const seen: { headers: Headers; body: Record<string, unknown> }[] = []
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(
        "https://chatgpt.com/backend-api/codex/responses"
      )
      const body = JSON.parse(String(init?.body))
      seen.push({ headers: new Headers(init?.headers), body })
      const image = JSON.stringify(body.input).includes("input_image")
      return codexStream(
        body.model,
        JSON.stringify(image ? { color: "red" } : { answer: 5 }),
        { input: 11, output: 2 }
      )
    })

    const model = await subscriptionModel("gpt-fixture", fetcher)
    const text = await generateText({
      model,
      maxRetries: 0,
      system: "Answer in JSON.",
      output: Output.object({ schema: z.object({ answer: z.number() }) }),
      prompt: "2 + 3",
    })
    expect(text.output).toEqual({ answer: 5 })
    const image = await generateText({
      model,
      maxRetries: 0,
      output: Output.object({ schema: z.object({ color: z.string() }) }),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Colour?" },
            {
              type: "file",
              data: new Uint8Array([1, 2, 3]),
              mediaType: "image/png",
            },
          ],
        },
      ],
    })
    expect(image.output).toEqual({ color: "red" })

    const [first] = seen
    expect(first.headers.get("authorization")).toBe("Bearer access-live")
    expect(first.headers.get("chatgpt-account-id")).toBe("acct_fixture")
    expect(first.headers.get("originator")).toBe("anonify")
    expect(first.body).toMatchObject({
      model: "gpt-fixture",
      instructions: "Answer in JSON.",
      store: false,
      stream: true,
      text: { format: { type: "json_schema" } },
    })
    expect(JSON.stringify(first.body.input)).not.toContain("Answer in JSON.")
  })
})

/** A backend turn that thinks, then calls a tool, as the real stream sends it. */
function codexToolCall(): Response {
  const reasoning = {
    id: "rs_fixture",
    type: "reasoning",
    summary: [],
    encrypted_content: "sealed-thoughts",
  }
  const call = {
    id: "fc_fixture",
    type: "function_call",
    status: "completed",
    call_id: "call_fixture",
    name: "lookup",
    arguments: '{"q":"EMP"}',
  }
  const response = (status: string) => ({
    id: "resp_tool",
    object: "response",
    created_at: 1,
    status,
    model: "gpt-fixture",
    output: [],
    usage:
      status === "completed"
        ? { input_tokens: 5, output_tokens: 5, total_tokens: 10 }
        : null,
  })
  const events = [
    { type: "response.created", response: response("in_progress") },
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning } },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...call, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: call.id,
      output_index: 1,
      delta: call.arguments,
    },
    { type: "response.output_item.done", output_index: 1, item: call },
    { type: "response.completed", response: response("completed") },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}
data: ${JSON.stringify(event)}

`).join(""),
    { status: 200 }
  )
}

describe("streaming through the Codex transport", () => {
  beforeEach(async () => {
    await saveLogin({
      access: "access-live",
      refresh: "refresh-live",
      expiresAt: Date.now() + 3_600_000,
      accountId: "acct_fixture",
    })
  })

  // Hush streams. The transport used to collect every answer into one JSON
  // object, which is right for a single structured call and wrong for a
  // stream: the reader found no events and every reply came back empty.
  it("hands a streaming call the backend's events, so its text arrives", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      codexStream("gpt-fixture", "Hello from the plan.")
    )
    const model = await subscriptionModel("gpt-fixture", fetcher)
    const result = streamText({ model, maxRetries: 0, prompt: "Say hello" })
    expect(await result.text).toBe("Hello from the plan.")
  })

  // The backend stores nothing, so the second step of a tool loop must send
  // the first step's items whole. Referring to them by id — what the SDK does
  // unless told — failed every tool loop with "Item … not found".
  it("sends a tool loop's earlier items whole, never by reference", async () => {
    const bodies: Record<string, unknown>[] = []
    let calls = 0
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      calls += 1
      return calls === 1 ? codexToolCall() : codexStream("gpt-fixture", "Found it.")
    })
    const model = await subscriptionModel("gpt-fixture", fetcher)
    const result = streamText({
      model,
      maxRetries: 0,
      prompt: "Look up EMP",
      tools: {
        lookup: tool({
          inputSchema: z.object({ q: z.string() }),
          execute: async () => "EMP-00123 on page 1",
        }),
      },
      stopWhen: isStepCount(3),
    })

    expect(await result.text).toBe("Found it.")
    expect(bodies).toHaveLength(2)
    const second = JSON.stringify(bodies[1])
    expect(second).not.toContain("item_reference")
    expect(second).toContain("sealed-thoughts")
    expect(bodies[0]).toMatchObject({
      store: false,
      include: expect.arrayContaining(["reasoning.encrypted_content"]),
    })
  })
})

describe("the provider", () => {
  it("is selectable, needs no key in .env and asks for a login instead", () => {
    const provider = selectedProvider({ AI_PROVIDER: "openai-subscription" })
    expect(provider.login).toBe("openai")
    expect(provider.envKey).toBeUndefined()
    expect(providerConfigured({ AI_PROVIDER: "openai-subscription" })).toBe(
      true
    )
  })

  it("uses a price the operator recorded for it, and $0 otherwise", () => {
    const priced = {
      AI_MODEL_PRICES: JSON.stringify({
        "openai-subscription:gpt-fixture": {
          inputPerMillion: 1.25,
          outputPerMillion: 10,
        },
      }),
    }
    expect(ratesFor(priced, "openai-subscription:gpt-fixture")).toEqual({
      inputPerMillion: 1.25,
      outputPerMillion: 10,
    })
    expect(ratesFor(priced, "openai-subscription:other")).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    })
  })

  it("costs nothing per token, so an unpriced row cannot disable the spend cap", () => {
    vi.stubEnv("AI_MODEL_PRICES", "")
    expect(ratesFor({}, "openai-subscription:gpt-fixture")).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    })
    expect(
      estimateRows([
        {
          model: "openai-subscription:gpt-fixture",
          inputTokens: 5,
          outputTokens: 5,
        },
      ])
    ).toBe(0)
  })

  it("reports a missing sign-in as a visible authorization skip, with nothing secret logged", async () => {
    const env = { AI_PROVIDER: "openai-subscription", AI_MODEL: "gpt-fixture" }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    vi.stubEnv(
      "AI_MODEL_CAPABILITIES",
      capabilityDeclaration(env, { structuredOutput: true, vision: true })
    )
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await runStructured({
      task: "fixture",
      documentId: "doc_fixture",
      system: "s",
      prompt: "p",
      schema: z.object({}),
    })
    expect(result).toMatchObject({ output: null, skipped: "authorization" })
    expect(usageCreate).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledTimes(1)
  })
})

describe("the loopback callback", () => {
  it("ignores a stray visit, and hands over the code for its own state", async () => {
    const server = await startCallbackServer("expected-state", 0)
    expect(server).not.toBeNull()
    const base = `http://127.0.0.1:${server!.port}/auth/callback`
    try {
      const stray = await fetch(`${base}?code=nope&state=wrong`)
      expect(stray.status).toBe(400)
      const text = await stray.text()
      expect(text).not.toContain("nope")
      expect(text).not.toContain("wrong")
      expect(
        (await fetch(`http://127.0.0.1:${server!.port}/other`)).status
      ).toBe(404)

      const good = await fetch(`${base}?code=the-code&state=expected-state`)
      expect(good.status).toBe(200)
      expect(good.headers.get("referrer-policy")).toBe("no-referrer")
      await expect(server!.code).resolves.toBe("the-code")
    } finally {
      server!.close()
    }
  })

  it("ends the sign-in when the provider refuses it", async () => {
    const server = await startCallbackServer("s", 0)
    try {
      await fetch(
        `http://127.0.0.1:${server!.port}/auth/callback?error=access_denied`
      )
      await expect(server!.code).rejects.toThrow("refused (access_denied)")
    } finally {
      server!.close()
    }
  })

  it("gives way to the paste fallback when the port is taken", async () => {
    const first = await startCallbackServer("s", 0)
    try {
      expect(await startCallbackServer("s", first!.port)).toBeNull()
    } finally {
      first!.close()
    }
  })

  it("does not try to open a browser over SSH or without a display", () => {
    expect(canOpenBrowser({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBe(false)
    expect(canOpenBrowser({}, "linux")).toBe(false)
    expect(canOpenBrowser({ DISPLAY: ":0" }, "linux")).toBe(true)
    expect(canOpenBrowser({}, "win32")).toBe(true)
  })
})
