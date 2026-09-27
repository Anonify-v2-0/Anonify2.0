import { createServer, type IncomingMessage } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"

import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { cacheable, catalogTarget } from "@/lib/ai/catalog"
import {
  PROVIDERS,
  providerConfigured,
  selectedProvider,
} from "@/lib/ai/providers"
import { COMPATIBLE_PROFILES } from "@/lib/ai/providers/compatible"
import {
  capabilityDeclaration,
  capabilityTarget,
  compatibleBaseUrl,
  configuredCapabilities,
  isLocalProvider,
} from "@/lib/ai/providers/config"
import { discoverModels, parseModel } from "@/lib/ai/providers/discovery"
import { probeModel } from "@/lib/ai/providers/probe"
import { estimateRows, ratesFor } from "@/lib/ai/rates"
import { serviceDefaults } from "@/lib/services/limits"
import { resetThrottles } from "@/lib/services/throttle"
import { AI_ENV_KEYS } from "../scripts/setup-ai"

const usageCreate = vi.fn()
vi.mock("@/lib/database/prisma", () => ({
  prisma: { aiUsage: { create: (...args: unknown[]) => usageCreate(...args) } },
}))
const { runStructured } = await import("@/lib/ai/gateway")

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetThrottles()
  usageCreate.mockReset()
})

describe("the profile table", () => {
  it("makes every row a provider through the OpenAI-compatible adapter", () => {
    for (const profile of COMPATIBLE_PROFILES) {
      const provider = selectedProvider({ AI_PROVIDER: profile.id })
      expect(provider.compatible).toBe(profile)
      expect(provider.label).toBe(profile.label)
      expect(provider.envKey).toBe(profile.envKey)
    }
    expect(COMPATIBLE_PROFILES.map((profile) => profile.id)).toEqual([
      "openrouter",
      "synthetic",
      "lm-studio",
      "llama-cpp",
      "openai-compatible",
    ])
    // Ids are the AI_PROVIDER value and a usage-row prefix; one each.
    const ids = PROVIDERS.map((provider) => provider.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("puts every profile's variables in setup's .env group", () => {
    for (const key of [
      "AI_BASE_URL",
      "AI_API_KEY",
      "OPENROUTER_API_KEY",
      "SYNTHETIC_API_KEY",
    ])
      expect(AI_ENV_KEYS).toContain(key)
  })

  it("requires a hosted vendor's key, and not a local server's or a URL endpoint's", () => {
    expect(providerConfigured({ AI_PROVIDER: "openrouter" })).toBe(false)
    expect(
      providerConfigured({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" })
    ).toBe(true)
    expect(providerConfigured({ AI_PROVIDER: "synthetic" })).toBe(false)
    expect(providerConfigured({ AI_PROVIDER: "lm-studio" })).toBe(true)
    expect(providerConfigured({ AI_PROVIDER: "llama-cpp" })).toBe(true)
    expect(providerConfigured({ AI_PROVIDER: "openai-compatible" })).toBe(true)
  })
})

describe("base URLs", () => {
  it("fixes a hosted vendor's URL, whatever AI_BASE_URL says", () => {
    expect(
      compatibleBaseUrl({
        AI_PROVIDER: "openrouter",
        AI_BASE_URL: "http://evil.example/v1",
      })
    ).toBe("https://openrouter.ai/api/v1")
    expect(compatibleBaseUrl({ AI_PROVIDER: "synthetic" })).toBe(
      "https://api.synthetic.new/openai/v1"
    )
  })

  it("defaults a local server's URL and lets AI_BASE_URL move it", () => {
    expect(compatibleBaseUrl({ AI_PROVIDER: "lm-studio" })).toBe(
      "http://localhost:1234/v1"
    )
    expect(compatibleBaseUrl({ AI_PROVIDER: "llama-cpp" })).toBe(
      "http://localhost:8080/v1"
    )
    expect(
      compatibleBaseUrl({
        AI_PROVIDER: "llama-cpp",
        AI_BASE_URL: "http://gpu-box:9000/v1/",
      })
    ).toBe("http://gpu-box:9000/v1")
  })

  it("requires AI_BASE_URL for the generic endpoint, and refuses credentials in it", () => {
    expect(() =>
      compatibleBaseUrl({ AI_PROVIDER: "openai-compatible" })
    ).toThrow("AI_BASE_URL is required")
    for (const url of [
      "http://user:pass@host/v1",
      "http://host/v1?key=secret",
      "ftp://host/v1",
      "not a url",
    ]) {
      const error = (() => {
        try {
          compatibleBaseUrl({
            AI_PROVIDER: "openai-compatible",
            AI_BASE_URL: url,
          })
        } catch (caught) {
          return caught as Error
        }
      })()
      expect(error?.message).toMatch(/^AI_BASE_URL must be/)
      // The value is never repeated: it may be the thing that holds a key.
      expect(error?.message).not.toContain("secret")
      expect(error?.message).not.toContain("pass")
    }
  })

  it("reaches a loopback server on the Docker host from inside a container", () => {
    const env = {
      AI_PROVIDER: "lm-studio",
      AI_BASE_URL: "http://127.0.0.1:1234/v1",
      ANONIFY_CONTAINER: "1",
    }
    expect(compatibleBaseUrl(env)).toBe("http://host.docker.internal:1234/v1")
    // What a declaration is bound to is what the operator wrote.
    expect(compatibleBaseUrl(env, false)).toBe("http://127.0.0.1:1234/v1")
  })
})

describe("capability declarations", () => {
  it("leaves every existing provider's target exactly as it was", () => {
    // Written by v1.7.0's setup. If this changes, every verified install's
    // contextual pass turns "unsupported" on upgrade.
    expect(
      capabilityTarget({
        AI_PROVIDER: "ollama",
        AI_MODEL: "qwen",
        OLLAMA_BASE_URL: "http://localhost:11434",
      })
    ).toBe('["ollama","qwen","http://localhost:11434","","","","",false]')
    expect(
      capabilityTarget({
        AI_PROVIDER: "google-vertex",
        AI_MODEL: "gemini",
        GOOGLE_VERTEX_PROJECT: "p",
        GOOGLE_VERTEX_LOCATION: "l",
      })
    ).toBe('["google-vertex","gemini","","","","p","l",false]')
  })

  it("binds a compatible provider's verification to its endpoint", () => {
    const env = {
      AI_PROVIDER: "openai-compatible",
      AI_MODEL: "m",
      AI_BASE_URL: "http://vllm.internal/v1",
    }
    vi.stubEnv("AI_PROVIDER", "")
    const declared = {
      ...env,
      AI_MODEL_CAPABILITIES: capabilityDeclaration(env, {
        structuredOutput: true,
        vision: false,
      }),
    }
    expect(configuredCapabilities(declared)).toEqual({
      structuredOutput: true,
      vision: false,
    })
    expect(
      configuredCapabilities({
        ...declared,
        AI_BASE_URL: "http://other.internal/v1",
      })
    ).toEqual({ structuredOutput: false, vision: false })
    expect(
      catalogTarget({ ...env, AI_BASE_URL: "http://other.internal/v1" })
    ).not.toBe(catalogTarget(env))
  })
})

describe("local servers", () => {
  it("are free, one request at a time and read live; a URL endpoint is none of those", () => {
    expect(isLocalProvider("lm-studio")).toBe(true)
    expect(isLocalProvider("llama-cpp")).toBe(true)
    expect(isLocalProvider("ollama")).toBe(true)
    expect(isLocalProvider("openai-compatible")).toBe(false)
    expect(isLocalProvider("openrouter")).toBe(false)

    expect(ratesFor({}, "lm-studio:qwen")).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    })
    expect(ratesFor({}, "llama-cpp:m")).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    })
    expect(ratesFor({}, "openai-compatible:m")).toBeNull()
    vi.stubEnv("AI_MODEL_PRICES", "")
    expect(
      estimateRows([
        { model: "lm-studio:qwen", inputTokens: 9, outputTokens: 9 },
        { model: "llama-cpp:m", inputTokens: 9, outputTokens: 9 },
      ])
    ).toBe(0)

    vi.stubEnv("AI_PROVIDER", "llama-cpp")
    expect(serviceDefaults("ai").concurrency).toBe(1)
    vi.stubEnv("AI_PROVIDER", "openai-compatible")
    expect(serviceDefaults("ai").concurrency).toBe(4)

    expect(cacheable({ AI_PROVIDER: "lm-studio" })).toBe(false)
    expect(cacheable({ AI_PROVIDER: "openrouter" })).toBe(true)
    expect(cacheable({ AI_PROVIDER: "openai-subscription" })).toBe(false)
  })
})

describe("OpenRouter's model list", () => {
  it("reads its documented per-token prices, image input and structured-output support", () => {
    const model = parseModel("openrouter", {
      id: "vendor/model",
      name: "Vendor: Model",
      context_length: 128000,
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
      pricing: { prompt: "0.000003", completion: "0.000015" },
      supported_parameters: ["tools", "structured_outputs", "response_format"],
    })
    expect(model).toMatchObject({
      id: "vendor/model",
      name: "Vendor: Model",
      contextWindow: 128000,
      vision: true,
      textOutput: true,
      structuredOutput: true,
      price: { inputPerMillion: 3, outputPerMillion: 15 },
    })
    expect(
      parseModel("openrouter", {
        id: "plain",
        supported_parameters: ["tools", "temperature"],
      })?.structuredOutput
    ).toBe(false)
    // The same fields from a profile that never documented their unit.
    expect(
      parseModel("synthetic", {
        id: "x",
        pricing: { prompt: "0.000003", completion: "0.000015" },
      })?.price
    ).toBeUndefined()
  })
})

type Seen = {
  url: string
  authorization?: string
  body: Record<string, unknown>
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString() || "{}")
}

/** An OpenAI-compatible server, the way vLLM, LM Studio and llama.cpp answer. */
async function compatibleServer() {
  const seen: Seen[] = []
  const server = createServer(async (request, response) => {
    const body = await readBody(request)
    seen.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
      body,
    })
    response.setHeader("Content-Type", "application/json")
    if (request.url === "/v1/models") {
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "local-vl", object: "model" }],
        })
      )
      return
    }
    const content = (body.messages as { content: unknown }[]).at(-1)?.content
    const hasImage =
      Array.isArray(content) &&
      content.some((part: { type: string }) => part.type === "image_url")
    response.end(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "local-vl",
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
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      })
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe("real AI SDK calls to an endpoint named by URL", () => {
  it("discovers, verifies and calls it, with its key and a JSON schema", async () => {
    const fixture = await compatibleServer()
    try {
      const env = {
        AI_PROVIDER: "openai-compatible",
        AI_BASE_URL: fixture.url,
        AI_API_KEY: "fixture-key",
        AI_MODEL: "local-vl",
      }
      expect((await discoverModels(env)).map((model) => model.id)).toEqual([
        "local-vl",
      ])
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
            model: "openai-compatible:local-vl",
            inputTokens: 7,
            outputTokens: 3,
          }),
        })
      )

      expect(fixture.seen.map((request) => request.url)).toEqual([
        "/v1/models",
        "/v1/chat/completions",
        "/v1/chat/completions",
        "/v1/chat/completions",
      ])
      for (const request of fixture.seen)
        expect(request.authorization).toBe("Bearer fixture-key")
      expect(fixture.seen[1].body.response_format).toMatchObject({
        type: "json_schema",
      })
    } finally {
      await fixture.close()
    }
  })

  it("sends no Authorization header to a server that takes no key", async () => {
    const fixture = await compatibleServer()
    try {
      const env = {
        AI_PROVIDER: "llama-cpp",
        AI_BASE_URL: fixture.url,
        AI_MODEL: "local-vl",
      }
      await discoverModels(env)
      await probeModel(env)
      expect(fixture.seen.length).toBeGreaterThan(1)
      for (const request of fixture.seen)
        expect(request.authorization).toBeUndefined()
    } finally {
      await fixture.close()
    }
  })

  it("skips the pass, rather than calling, until the endpoint is verified", async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetcher)
    vi.stubEnv("AI_PROVIDER", "lm-studio")
    vi.stubEnv("AI_MODEL", "m")
    vi.stubEnv("AI_MODEL_CAPABILITIES", "")
    const response = await runStructured({
      task: "fixture",
      documentId: "doc_fixture",
      system: "s",
      prompt: "p",
      schema: z.object({}),
    })
    expect(response.skipped).toBe("unsupported")
    expect(fetcher).not.toHaveBeenCalled()
  })
})
