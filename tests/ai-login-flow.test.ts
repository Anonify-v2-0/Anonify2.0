import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { configuredCapabilities } from "@/lib/ai/providers/config"
import { discoverModels } from "@/lib/ai/providers/discovery"
import { ratesFor } from "@/lib/ai/rates"
import { resetThrottles } from "@/lib/services/throttle"
import { parseEnv } from "../scripts/env-file"
import type { Choice, Prompter } from "../scripts/tty"

/**
 * What happens after `pnpm ai login`: the plan's models listed from OpenAI,
 * one chosen, verified against OpenAI, priced, and written to `.env`.
 *
 * The subscription is the provider least like the others — a sealed token
 * rather than a key, a model list in Codex's own shape, a streamed-only
 * backend — so the whole sequence runs here against a fake of OpenAI's side:
 * the token endpoint, the Codex model list and the Codex Responses endpoint.
 * Everything on our side is the real code: the sealed store, refresh,
 * discovery, setup's picker, the probe over the Codex transport, the price
 * and the `.env` writer.
 */

const settings = new Map<string, unknown>()
vi.mock("@/lib/database/prisma", () => ({
  prisma: {
    aiUsage: { create: async () => ({}) },
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
      deleteMany: async ({ where }: { where: { key: string } }) => ({
        count: settings.delete(where.key) ? 1 : 0,
      }),
    },
  },
}))

const { saveLogin, loadLogin } = await import("@/lib/ai/providers/subscription")
const { configureModel, switchProvider, writeSettings } =
  await import("../scripts/ai-configure")
const { askAiProvider } = await import("../scripts/setup-ai")

/** The plan's models, as Codex's `ModelsResponse` carries them. */
const PLAN_MODELS = [
  {
    slug: "gpt-vision",
    display_name: "GPT Vision",
    visibility: "list",
    priority: 2,
    input_modalities: ["text", "image"],
    context_window: 272000,
    supported_in_api: true,
  },
  {
    slug: "gpt-text",
    display_name: "GPT Text",
    visibility: "list",
    priority: 1,
    input_modalities: ["text"],
    supported_in_api: true,
  },
  // Codex's picker leaves these out, and so do we.
  {
    slug: "gpt-internal",
    display_name: "Internal",
    visibility: "hide",
    priority: 0,
  },
  {
    slug: "gpt-retired",
    display_name: "Retired",
    visibility: "none",
    priority: 0,
  },
  // An older payload with neither field; Codex shows it, last.
  { slug: "gpt-legacy", display_name: "Legacy" },
]

type Seen = { url: URL; headers: Headers; body?: Record<string, unknown> }

/** A fake of OpenAI's side of the conversation. */
function fakeOpenAI(options: { refusedModels?: string[] } = {}) {
  const seen: Seen[] = []
  let issued = 0
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      )
      const headers = new Headers(init?.headers)
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      seen.push({ url, headers, body })

      if (url.href === "https://auth.openai.com/oauth/token") {
        issued += 1
        return Response.json({
          access_token: `access-refreshed-${issued}`,
          refresh_token: `refresh-refreshed-${issued}`,
          expires_in: 3600,
        })
      }
      if (
        url.origin + url.pathname ===
        "https://chatgpt.com/backend-api/codex/models"
      ) {
        return Response.json({ models: PLAN_MODELS })
      }
      if (
        url.origin + url.pathname ===
        "https://chatgpt.com/backend-api/codex/responses"
      ) {
        const model = String(body?.model)
        const image = JSON.stringify(body?.input).includes("input_image")
        const known = PLAN_MODELS.some((entry) => entry.slug === model)
        if (!known || options.refusedModels?.includes(model))
          return Response.json(
            { error: { message: "The requested model is not available." } },
            { status: 400 }
          )
        // The backend refuses an image for a text-only model.
        if (image && model === "gpt-text")
          return Response.json(
            { error: { message: "Image input is not supported." } },
            { status: 400 }
          )
        const response = {
          id: "resp_fixture",
          object: "response",
          created_at: 1,
          status: "completed",
          model,
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(
                    image ? { color: "red" } : { answer: 5 }
                  ),
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 3 },
        }
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
      }
      return new Response("not found", { status: 404 })
    }
  )
  vi.stubGlobal("fetch", fetcher)
  return {
    seen,
    requests: (path: string) =>
      seen.filter((request) => request.url.pathname.endsWith(path)),
  }
}

/** A terminal that answers as scripted and records what it was asked. */
function terminal(answers: {
  analyze?: boolean
  model?: string
  recordPrice?: boolean
  amounts?: number[]
}) {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  const amounts = [...(answers.amounts ?? [])]
  const offered: Choice<unknown>[][] = []
  const prompt = {
    interactive: true,
    choose: vi.fn(async (question: string, choices: Choice<unknown>[]) => {
      if (question === "What should the model analyze?")
        return answers.analyze ?? true
      return choices[0].value
    }),
    choosePaged: vi.fn(
      async (
        _question: string,
        choices: Choice<unknown>[],
        options: { actions?: Choice<unknown>[] } = {}
      ) => {
        offered.push(choices)
        if (answers.model) return answers.model
        return options.actions!.at(-1)!.value
      }
    ),
    confirm: vi.fn(async (question: string) =>
      /price/i.test(question) ? Boolean(answers.recordPrice) : true
    ),
    askAmount: vi.fn(async () => amounts.shift() ?? 0),
    ask: vi.fn(async () => ""),
    secret: vi.fn(async () => ""),
  } as unknown as Prompter
  return { prompt, offered }
}

async function signIn(overrides: { expiresAt?: number } = {}) {
  await saveLogin({
    access: "access-live",
    refresh: "refresh-live",
    expiresAt: overrides.expiresAt ?? Date.now() + 3_600_000,
    accountId: "acct_fixture",
  })
}

let directory = ""
beforeEach(async () => {
  settings.clear()
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"))
  directory = await mkdtemp(path.join(tmpdir(), "anonify-login-flow-"))
  vi.stubEnv("ANONIFY_MODEL_CACHE_PATH", directory)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetThrottles()
  await rm(directory, { recursive: true, force: true })
})

const SUBSCRIPTION = { AI_PROVIDER: "openai-subscription" }

describe("after signing in: the plan's models, from OpenAI", () => {
  it("lists what Codex's own picker would, in its order, as the signed-in workspace", async () => {
    await signIn()
    const openai = fakeOpenAI()

    const models = await discoverModels(SUBSCRIPTION)

    expect(models.map((model) => model.id)).toEqual([
      "gpt-text",
      "gpt-vision",
      "gpt-legacy",
    ])
    expect(models[1]).toMatchObject({
      name: "GPT Vision",
      vision: true,
      textOutput: true,
      contextWindow: 272000,
    })
    expect(models[0].vision).toBe(false)

    const [listing] = openai.requests("/models")
    expect(listing.url.searchParams.get("client_version")).toBeTruthy()
    expect(listing.headers.get("authorization")).toBe("Bearer access-live")
    expect(listing.headers.get("chatgpt-account-id")).toBe("acct_fixture")
    expect(listing.headers.get("originator")).toBe("anonify")
  })

  it("refreshes a sign-in about to expire before it asks, and keeps the new token", async () => {
    await signIn({ expiresAt: Date.now() + 10_000 })
    const openai = fakeOpenAI()

    await discoverModels(SUBSCRIPTION)

    expect(openai.seen.map((request) => request.url.pathname)).toEqual([
      "/oauth/token",
      "/backend-api/codex/models",
    ])
    expect(openai.requests("/models")[0].headers.get("authorization")).toBe(
      "Bearer access-refreshed-1"
    )
    expect((await loadLogin())?.access).toBe("access-refreshed-1")
  })

  it("says to sign in, rather than failing obscurely, when nobody has", async () => {
    fakeOpenAI()
    await expect(discoverModels(SUBSCRIPTION)).rejects.toThrow(
      "pnpm ai login --provider openai"
    )
  })
})

describe("after signing in: choosing, verifying and pricing a model", () => {
  it("verifies the chosen model against OpenAI, records its price and writes .env", async () => {
    await signIn()
    const openai = fakeOpenAI()
    const { prompt } = terminal({
      model: "gpt-vision",
      recordPrice: true,
      amounts: [1.25, 10],
    })

    const updates = await configureModel({
      env: switchProvider({}, "openai-subscription"),
      before: {},
      prompt,
    })

    expect(updates).not.toBeNull()
    expect(updates).toMatchObject({
      AI_PROVIDER: "openai-subscription",
      AI_MODEL: "gpt-vision",
    })
    expect(configuredCapabilities({ ...updates })).toEqual({
      structuredOutput: true,
      vision: true,
    })
    // Two synthetic requests, both to the chosen model, both unstored.
    const probes = openai.requests("/responses")
    expect(probes).toHaveLength(2)
    for (const probe of probes)
      expect(probe.body).toMatchObject({
        model: "gpt-vision",
        store: false,
        stream: true,
      })

    // And what reaches .env is what the app will read and charge.
    const file = path.join(directory, ".env")
    await writeFile(
      file,
      "# kept\nAI_PROVIDER=gateway\nENCRYPTION_KEY=keep-me\n"
    )
    writeSettings(updates!, { file })
    const written = parseEnv(await readFile(file, "utf8"))
    expect(written.get("ENCRYPTION_KEY")).toBe("keep-me")
    expect(written.get("AI_MODEL")).toBe("gpt-vision")
    const env = Object.fromEntries(written)
    expect(configuredCapabilities(env).vision).toBe(true)
    expect(ratesFor(env)).toEqual({
      inputPerMillion: 1.25,
      outputPerMillion: 10,
    })
    expect(await readFile(file, "utf8")).not.toContain("access-live")
  })

  it("leaves the price at $0 when the operator declines to record one", async () => {
    await signIn()
    fakeOpenAI()
    const { prompt } = terminal({ model: "gpt-vision", recordPrice: false })

    const updates = await configureModel({
      env: switchProvider({}, "openai-subscription"),
      before: {},
      prompt,
    })

    expect(updates?.AI_MODEL_PRICES).toBeUndefined()
    expect(ratesFor({ ...updates })).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    })
  })

  it("disables a text-only model for image analysis, and verifies it for text", async () => {
    await signIn()
    fakeOpenAI()

    // Looks at the list, then backs out: nothing is verified or written.
    const strict = terminal({})
    expect(
      await configureModel({
        env: switchProvider({}, "openai-subscription"),
        before: {},
        prompt: strict.prompt,
      })
    ).toBeNull()
    const offered = strict.offered[0]
    expect(
      offered.find((choice) => choice.value === "gpt-text")?.disabled
    ).toContain("images")
    expect(
      offered.find((choice) => choice.value === "gpt-vision")?.disabled
    ).toBeUndefined()
    vi.restoreAllMocks()

    const relaxed = terminal({ analyze: false, model: "gpt-text" })
    const updates = await configureModel({
      env: switchProvider({}, "openai-subscription"),
      before: {},
      prompt: relaxed.prompt,
    })
    expect(configuredCapabilities({ ...updates })).toEqual({
      structuredOutput: true,
      vision: false,
    })
  })

  it("verifies a model named on the command line, without a terminal, with a price given there", async () => {
    await signIn()
    const openai = fakeOpenAI()

    const updates = await configureModel({
      env: switchProvider({}, "openai-subscription", "gpt-vision"),
      before: {},
      price: { inputPerMillion: 2, outputPerMillion: 8 },
    })

    expect(updates?.AI_MODEL).toBe("gpt-vision")
    expect(openai.requests("/models")).toHaveLength(0)
    expect(ratesFor({ ...updates })).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 8,
    })
  })

  it("keeps other models' recorded prices when it adds this one", async () => {
    await signIn()
    fakeOpenAI()
    const before = {
      AI_MODEL_PRICES: JSON.stringify({
        "openai:gpt-api": { inputPerMillion: 3, outputPerMillion: 4 },
      }),
    }

    const updates = await configureModel({
      env: switchProvider(before, "openai-subscription", "gpt-vision"),
      before,
      price: { inputPerMillion: 1, outputPerMillion: 2 },
    })

    expect(JSON.parse(updates!.AI_MODEL_PRICES)).toEqual({
      "openai:gpt-api": { inputPerMillion: 3, outputPerMillion: 4 },
      "openai-subscription:gpt-vision": {
        inputPerMillion: 1,
        outputPerMillion: 2,
      },
    })
  })

  it("changes nothing when OpenAI refuses the model", async () => {
    await signIn()
    fakeOpenAI({ refusedModels: ["gpt-vision"] })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    expect(
      await configureModel({
        env: switchProvider({}, "openai-subscription", "gpt-vision"),
        before: {},
      })
    ).toBeNull()
    expect(
      await configureModel({
        env: switchProvider({}, "openai-subscription", "gpt-not-on-this-plan"),
        before: {},
      })
    ).toBeNull()
  })

  it("does not carry another provider's model or verification across a switch", () => {
    const env = switchProvider(
      {
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-api",
        AI_MODEL_CAPABILITIES: "{}",
        OPENAI_API_KEY: "sk-kept",
      },
      "openai-subscription"
    )
    expect(env).toMatchObject({
      AI_PROVIDER: "openai-subscription",
      AI_MODEL: "",
      AI_MODEL_CAPABILITIES: "",
      OPENAI_API_KEY: "sk-kept",
    })
    expect(() => switchProvider({}, "made-up")).toThrow(
      'Unknown provider "made-up"'
    )
  })
})

describe("pnpm setup, for a subscription already signed in", () => {
  it("lists the plan's models, verifies the choice and offers to record a price", async () => {
    await signIn()
    fakeOpenAI()
    const { prompt } = terminal({
      model: "gpt-vision",
      recordPrice: true,
      amounts: [0.5, 4],
    })
    vi.mocked(prompt.choose).mockImplementation(async (question: string) =>
      question === "Which AI provider?"
        ? "openai-subscription"
        : question === "What should the model analyze?"
          ? true
          : undefined
    )

    const env = await askAiProvider(prompt, {}, false)

    expect(env).toMatchObject({
      AI_PROVIDER: "openai-subscription",
      AI_MODEL: "gpt-vision",
    })
    expect(configuredCapabilities(env).vision).toBe(true)
    expect(ratesFor(env)).toEqual({ inputPerMillion: 0.5, outputPerMillion: 4 })
  })

  it("sends the operator to pnpm ai login when nobody has signed in", async () => {
    fakeOpenAI()
    const { prompt } = terminal({})
    vi.mocked(prompt.choose).mockResolvedValue("openai-subscription")

    const env = await askAiProvider(prompt, {}, false)

    expect(env.AI_PROVIDER).toBe("openai-subscription")
    expect(env.AI_MODEL).toBe("")
    expect(prompt.choosePaged).not.toHaveBeenCalled()
  })
})
