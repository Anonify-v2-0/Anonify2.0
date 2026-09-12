import { createServer } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { generateText, Output } from "ai"
import { z } from "zod"
import {
  languageModel,
  PROVIDERS,
  providerConfigured,
  selectedProvider,
} from "@/lib/ai/providers"
import {
  capabilityDeclaration,
  configuredCapabilities,
  modelId,
  ollamaUrl,
  usageModelId,
} from "@/lib/ai/providers/config"
import {
  blockedReason,
  discoverModels,
  parseModel,
} from "@/lib/ai/providers/discovery"
import { probeModel } from "@/lib/ai/providers/probe"
import { configuredRates, estimateRows } from "@/lib/ai/rates"
import { classifyServiceError, resetThrottles } from "@/lib/services/throttle"
import { serviceDefaults } from "@/lib/services/limits"
import { Prompter } from "../scripts/tty"
import { askAiProvider } from "../scripts/setup-ai"
import { parseEnv, renderEnv } from "../scripts/env-file"

const usageCreate = vi.fn()
vi.mock("@/lib/database/prisma", () => ({
  prisma: { aiUsage: { create: (...args: unknown[]) => usageCreate(...args) } },
}))
const { runStructured, skipIsFailure } = await import("@/lib/ai/gateway")

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetThrottles()
  usageCreate.mockReset()
})

describe("provider selection and compatibility", () => {
  it("keeps Gateway model and usage identifiers unchanged", () => {
    expect(selectedProvider({}).id).toBe("gateway")
    expect(modelId({})).toBe("anthropic/claude-haiku-4.5")
    expect(usageModelId({ AI_MODEL: "vendor/custom" })).toBe("vendor/custom")
    expect(providerConfigured({ AI_GATEWAY_API_KEY: "key" })).toBe(true)
    expect(providerConfigured({ VERCEL_OIDC_TOKEN: "token" })).toBe(true)
    expect(configuredCapabilities({})).toEqual({
      structuredOutput: true,
      vision: true,
    })
  })

  it("uses only the selected provider's credential and refuses unsupported providers", () => {
    expect(
      providerConfigured({
        AI_PROVIDER: "anthropic",
        AI_GATEWAY_API_KEY: "key",
      })
    ).toBe(false)
    expect(
      providerConfigured({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key" })
    ).toBe(true)
    for (const id of [
      "openrouter",
      "synthetic",
      "lm-studio",
      "openai-compatible",
      "llama-cpp",
    ]) {
      expect(() => selectedProvider({ AI_PROVIDER: id })).toThrow(
        "Unsupported AI_PROVIDER"
      )
    }
  })

  it.each(PROVIDERS.map((provider) => [provider.id]))(
    "constructs the official %s adapter without network access",
    async (id) => {
      const provider = selectedProvider({ AI_PROVIDER: id })
      const fetcher = vi.fn<typeof fetch>()
      const model = await languageModel(
        {
          AI_PROVIDER: id,
          AI_MODEL: "fixture-model",
          [provider.envKey || "KEY"]: "fixture-key",
          AZURE_RESOURCE_NAME: "fixture-resource",
          AWS_REGION: "us-east-1",
          GOOGLE_VERTEX_PROJECT: "fixture-project",
          GOOGLE_VERTEX_LOCATION: "us-central1",
        },
        fetcher
      )
      expect(typeof model).toBe("object")
      expect((model as { modelId: string }).modelId).toBe("fixture-model")
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it("invalidates verification when model, provider or destination changes", () => {
    const env = {
      AI_PROVIDER: "ollama",
      AI_MODEL: "fixture:tag",
      OLLAMA_BASE_URL: "http://localhost:11434",
    }
    const saved = {
      ...env,
      AI_MODEL_CAPABILITIES: capabilityDeclaration(env, {
        structuredOutput: true,
        vision: false,
      }),
    }
    expect(configuredCapabilities(saved)).toEqual({
      structuredOutput: true,
      vision: false,
    })
    for (const change of [
      { AI_MODEL: "other" },
      { AI_PROVIDER: "openai" },
      { OLLAMA_BASE_URL: "http://localhost:11435" },
    ]) {
      expect(
        configuredCapabilities({ ...saved, ...change }).structuredOutput
      ).toBe(false)
    }
    expect(
      configuredCapabilities({ ...saved, ANONIFY_CONTAINER: "1" })
        .structuredOutput
    ).toBe(true)
    expect(ollamaUrl({ ...saved, ANONIFY_CONTAINER: "1" })).toBe(
      "http://host.docker.internal:11434"
    )
  })
})

describe("live model catalog normalization", () => {
  it("paginates Anthropic's account catalog and uses native authentication", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "first" }],
          has_more: true,
          last_id: "first",
        })
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: "second" }], has_more: false })
      )
    const models = await discoverModels(
      { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "secret" },
      fetcher
    )
    expect(models.map((model) => model.id)).toEqual(["first", "second"])
    expect(String(fetcher.mock.calls[1][0])).toContain("after_id=first")
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      "x-api-key": "secret",
      "anthropic-version": "2023-06-01",
    })
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error")
  })

  it("paginates Google models and disables models without generateContent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: "models/embed",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
          nextPageToken: "next",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: "models/chat",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        })
      )
    const models = await discoverModels(
      { AI_PROVIDER: "google", GOOGLE_GENERATIVE_AI_API_KEY: "secret" },
      fetcher
    )
    expect(
      blockedReason(
        models.find((model) => model.id === "embed")!,
        true
      )
    ).toMatch("Does not generate text")
    expect(String(fetcher.mock.calls[1][0])).toContain("pageToken=next")
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      "x-goog-api-key": "secret",
    })
  })

  it("honors advertised structured and image incompatibilities without guessing unknown capabilities", () => {
    expect(
      blockedReason(
        parseModel("mistral", {
          id: "no-json",
          capabilities: { structured_outputs: false },
        })!,
        false
      )
    ).toContain("structured")
    const text = parseModel("mistral", {
      id: "text",
      capabilities: { completion_chat: true, vision: false },
    })!
    expect(blockedReason(text, true)).toContain("images")
    expect(blockedReason(text, false)).toBeUndefined()
    expect(parseModel("openai", { id: "future-model" })?.vision).toBeUndefined()
    expect(
      blockedReason(
        parseModel("gateway", { id: "vendor/embedding", type: "embedding" })!,
        true
      )
    ).toContain("text")
  })

  it("reads installed Ollama capabilities and disables cloud models", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          models: [{ name: "local" }, { name: "remote" }, { name: "embed" }],
        })
      )
      .mockResolvedValueOnce(
        Response.json({ capabilities: ["completion", "vision"] })
      )
      .mockResolvedValueOnce(
        Response.json({ capabilities: ["completion"], remote_model: "remote" })
      )
      .mockResolvedValueOnce(Response.json({ capabilities: ["embedding"] }))
    const models = await discoverModels({ AI_PROVIDER: "ollama" }, fetcher)
    expect(
      blockedReason(
        models.find((model) => model.id === "local")!,
        true
      )
    ).toBeUndefined()
    expect(
      blockedReason(
        models.find((model) => model.id === "remote")!,
        false
      )
    ).toContain("cloud")
    expect(
      blockedReason(
        models.find((model) => model.id === "embed")!,
        false
      )
    ).toContain("text")
  })

  it("contains response bodies and rejects broken pagination", async () => {
    const denied = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("secret-key in a provider error", { status: 401 })
      )
    await expect(
      discoverModels({ AI_PROVIDER: "openai" }, denied)
    ).rejects.toThrow("HTTP 401")
    const repeat = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ data: [], has_more: true, last_id: "same" })
      )
    await expect(
      discoverModels({ AI_PROVIDER: "anthropic" }, repeat)
    ).rejects.toThrow("pagination")
  })
})

describe("real AI SDK structured calls over local HTTP", () => {
  it("discovers, verifies and calls Ollama with image attachments and provider-qualified usage", async () => {
    const requests: Record<string, unknown>[] = []
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      if (req.url === "/api/tags") {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ models: [{ name: "fixture:latest" }] }))
        return
      }
      if (req.url === "/api/show") {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ capabilities: ["completion", "vision"] }))
        return
      }
      requests.push(body)
      const content = body.messages?.at(-1)?.content
      const hasImage =
        Array.isArray(content) &&
        content.some((part: { type: string }) => part.type === "image_url")
      res.setHeader("Content-Type", "application/json")
      res.end(
        JSON.stringify({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: "fixture:latest",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(
                  hasImage ? { color: "red" } : { answer: 5 }
                ),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        })
      )
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const env = {
        AI_PROVIDER: "ollama",
        AI_MODEL: "fixture:latest",
        OLLAMA_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }
      expect((await discoverModels(env))[0].vision).toBe(true)
      const result = await probeModel(env)
      expect(result).toEqual({ structuredOutput: true, vision: true })
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
      vi.stubEnv("AI_MODEL_CAPABILITIES", capabilityDeclaration(env, result))
      const response = await runStructured({
        task: "fixture",
        documentId: "doc_fixture",
        system: "Return JSON",
        prompt: "2 + 3",
        schema: z.object({ answer: z.number() }),
      })
      expect(response.output).toEqual({ answer: 5 })
      expect(usageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            model: "ollama:fixture:latest",
            inputTokens: 9,
            outputTokens: 4,
          }),
        })
      )
      expect(requests).toHaveLength(3)
      expect(requests[0].response_format).toMatchObject({ type: "json_schema" })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("sends direct Anthropic requests using the native adapter", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [{ type: "text", text: '{"answer":5}' }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        })
      )
    const model = await languageModel(
      {
        AI_PROVIDER: "anthropic",
        AI_MODEL: "claude-haiku-4-5",
        ANTHROPIC_API_KEY: "secret",
      },
      fetcher
    )
    const result = await generateText({
      model,
      maxRetries: 0,
      output: Output.object({ schema: z.object({ answer: z.number() }) }),
      prompt: "2 + 3",
    })
    expect(result.output.answer).toBe(5)
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "api.anthropic.com/v1/messages"
    )
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).get("x-api-key")
    ).toBe("secret")
  })

  it("skips unsupported images before making or recording a call", async () => {
    const env = { AI_PROVIDER: "ollama", AI_MODEL: "text-only" }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    vi.stubEnv(
      "AI_MODEL_CAPABILITIES",
      capabilityDeclaration(env, { structuredOutput: true, vision: false })
    )
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const result = await runStructured({
      task: "image",
      documentId: "doc_fixture",
      system: "",
      prompt: "",
      schema: z.object({}),
      images: [{ data: new Uint8Array([1]), mediaType: "image/png" }],
    })
    expect(result.skipped).toBe("unsupported")
    expect(skipIsFailure(result.skipped)).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    expect(usageCreate).not.toHaveBeenCalled()
  })

  it("does not retry a refused local connection wrapped by fetch", () => {
    expect(
      classifyServiceError(
        new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })
      )
    ).toMatchObject({ kind: "provider", retryable: false })
  })
})

describe("operator setup and accounting", () => {
  it("keeps noninteractive setup offline and preserves an existing direct provider", async () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const prompt = new Prompter(false)
    const current = {
      AI_PROVIDER: "openai",
      AI_MODEL: "existing",
      OPENAI_API_KEY: "secret",
      AI_MODEL_CAPABILITIES: "saved",
    }
    expect(await askAiProvider(prompt, current, true)).toMatchObject(current)
    expect(fetcher).not.toHaveBeenCalled()
    prompt.close()
  })

  it("never chooses a disabled fallback, even noninteractively", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const prompt = new Prompter(false)
    expect(
      await prompt.choose("Model", [
        { value: "bad", label: "bad", disabled: "No vision" },
        { value: "good", label: "good" },
      ])
    ).toBe("good")
    await expect(
      prompt.choose("Model", [
        { value: "bad", label: "bad", disabled: "No vision" },
      ])
    ).rejects.toThrow("No selectable")
    prompt.close()
  })

  it("round-trips capability JSON and keys containing comment characters", () => {
    const value = capabilityDeclaration(
      { AI_PROVIDER: "openai", AI_MODEL: "fixture" },
      { vision: true, structuredOutput: true }
    )
    const source = renderEnv("fixture", [
      {
        heading: "AI",
        lines: [
          { key: "AI_MODEL_CAPABILITIES", value },
          { key: "KEY", value: "key#with-comment" },
        ],
      },
    ])
    expect(parseEnv(source).get("AI_MODEL_CAPABILITIES")).toBe(value)
    expect(parseEnv(source).get("KEY")).toBe("key#with-comment")
  })

  it("uses each model's rates, refuses incomplete estimates and treats Ollama as zero spend", () => {
    vi.stubEnv(
      "AI_MODEL_PRICES",
      JSON.stringify({
        "openai:m": { inputPerMillion: 1, outputPerMillion: 2 },
        "anthropic:m": { inputPerMillion: 3, outputPerMillion: 4 },
      })
    )
    expect(
      estimateRows([
        { model: "openai:m", inputTokens: 1_000_000, outputTokens: 0 },
        { model: "anthropic:m", inputTokens: 1_000_000, outputTokens: 0 },
        { model: "ollama:m", inputTokens: 100, outputTokens: 100 },
      ])
    ).toBe(4)
    expect(configuredRates("unpriced")).toBeNull()
    expect(
      estimateRows([{ model: "unpriced", inputTokens: 1, outputTokens: 1 }])
    ).toBeNull()
    vi.stubEnv("AI_PROVIDER", "ollama")
    expect(serviceDefaults("ai").concurrency).toBe(1)
  })
})
