import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { askAiProvider, formatTokens, modelDetails } from "../scripts/setup-ai"
import { Prompter, type Choice, type PagedChoiceOptions } from "../scripts/tty"
import { configuredCapabilities } from "@/lib/ai/providers/config"
import { buildCatalog, loadCatalog, writeCatalog } from "@/lib/ai/catalog"
import { parseModel } from "@/lib/ai/providers/discovery"
import { ratesFor } from "@/lib/ai/rates"

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock("@/lib/ai/providers/probe", () => ({ probeModel: probe }))
// Every test gets its own empty model cache, never the repository's.
let cache = ""
beforeEach(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "anonify-models-"))
  vi.stubEnv("ANONIFY_MODEL_CACHE_PATH", cache)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  probe.mockReset()
  await rm(cache, { recursive: true, force: true })
})

function promptWith(
  choose: (
    question: string,
    choices: Choice<unknown>[],
    fallback?: number
  ) => unknown,
  typed = ""
) {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  const chooseMock = vi.fn(choose)
  return {
    interactive: true,
    choose: chooseMock,
    // Flattened, so each test can answer the model question like any menu.
    choosePaged: vi.fn(
      (
        question: string,
        choices: Choice<unknown>[],
        options: PagedChoiceOptions<unknown> = {}
      ) => chooseMock(question, [...choices, ...(options.actions ?? [])])
    ),
    ask: vi.fn(async () => typed),
    secret: vi.fn(async () => "new-secret"),
    confirm: vi.fn(async () => true),
  } as unknown as Prompter
}

it("does not let manual entry bypass disabled capabilities when changing provider", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        data: [
          { id: "embedding", type: "embedding" },
          { id: "compatible", type: "language" },
        ],
      })
    )
  )
  probe.mockResolvedValue({ structuredOutput: true, vision: true })
  let attempts = 0
  const prompt = promptWith((question, choices) => {
    if (question === "Which AI provider?") return "openai"
    if (question === "What should the model analyze?") return true
    expect(
      choices.find((choice) => choice.value === "embedding")?.disabled
    ).toContain("text")
    return attempts++ === 0
      ? choices.find((choice) => choice.label.startsWith("Enter a model"))!
          .value
      : "compatible"
  }, "embedding")
  const result = await askAiProvider(
    prompt,
    {
      AI_PROVIDER: "gateway",
      AI_MODEL: "old/vendor-model",
      AI_GATEWAY_API_KEY: "old-key",
    },
    false
  )
  expect(result.AI_PROVIDER).toBe("openai")
  expect(result.AI_MODEL).toBe("compatible")
  expect(configuredCapabilities(result)).toEqual({
    structuredOutput: true,
    vision: true,
  })
  expect(probe).toHaveBeenCalledTimes(1)
  expect(probe.mock.calls[0][0]).toMatchObject({
    AI_MODEL: "compatible",
    OPENAI_API_KEY: "new-secret",
  })
})

it("blocks failed verification and can leave the prior configuration intact", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [{ id: "broken" }] }))
  )
  probe.mockResolvedValue({ structuredOutput: false, vision: false })
  let attempts = 0
  const prompt = promptWith((question, choices) => {
    if (question === "Which AI provider?") return "openai"
    if (question === "What should the model analyze?") return true
    if (attempts++ === 0) return "broken"
    expect(
      choices.find((choice) => choice.value === "broken")?.disabled
    ).toContain("verification failed")
    return choices.find((choice) =>
      choice.label.startsWith("Keep the current")
    )!.value
  })
  const current = { AI_GATEWAY_API_KEY: "old-key", AI_MODEL: "vendor/old" }
  expect(await askAiProvider(prompt, current, false)).toEqual(current)
})

it("offers a responding Ollama as the fresh local default but requires installed model metadata", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/api/tags")
          ? { models: [{ name: "local" }] }
          : { capabilities: ["completion"] }
      )
    )
  )
  probe.mockResolvedValue({ structuredOutput: true, vision: false })
  const prompt = promptWith((question, choices, fallback) => {
    if (question === "Which AI provider?") {
      expect(choices[fallback!].value).toBe("ollama")
      return "ollama"
    }
    if (question === "What should the model analyze?") return false
    return "local"
  }, "http://localhost:11434")
  const result = await askAiProvider(prompt, {}, true)
  expect(configuredCapabilities(result)).toEqual({
    structuredOutput: true,
    vision: false,
  })
  expect(probe).toHaveBeenCalledTimes(1)
})

it("never echoes a retained secret in noninteractive mode", async () => {
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true)
  const prompt = new Prompter(false)
  expect(await prompt.secret("API key", "do-not-print")).toBe("do-not-print")
  expect(output).not.toHaveBeenCalled()
  prompt.close()
})

it("hands a large catalog to the paged selector with the escape hatches pinned", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        data: Array.from({ length: 120 }, (_, index) => ({
          id: `vendor/model-${String(index).padStart(3, "0")}`,
          name: `Model ${index}`,
          type: "language",
          context_window: 128_000,
        })),
      })
    )
  )
  probe.mockResolvedValue({ structuredOutput: true, vision: true })
  const prompt = promptWith((question) => {
    if (question === "Which AI provider?") return "gateway"
    if (question === "What should the model analyze?") return true
    return "vendor/model-042"
  })
  vi.mocked(prompt.confirm).mockImplementation(
    async (question) => !question.startsWith("Keep the current model")
  )
  const result = await askAiProvider(
    prompt,
    {
      AI_PROVIDER: "gateway",
      AI_GATEWAY_API_KEY: "key",
      AI_MODEL: "vendor/model-007",
    },
    false
  )
  expect(result.AI_MODEL).toBe("vendor/model-042")

  const [question, choices, options] = vi.mocked(prompt.choosePaged).mock
    .calls[0] as [string, Choice<unknown>[], PagedChoiceOptions<unknown>]
  expect(question).toBe("Which model?")
  // Every model is paged; the two actions are not models and are never paged.
  expect(choices).toHaveLength(120)
  expect(options.actions!.map((action) => action.label)).toEqual([
    "Enter a model / deployment ID and verify it",
    "Keep the current configuration and finish setup",
  ])
  expect(options.initial).toBe("vendor/model-007")
  expect(choices[7].label).toBe("vendor/model-007 (current)")
  expect(choices[42].detail).toEqual([
    "Model 42",
    "Advertised: text yes · images unknown · structured output unknown · 128K context",
  ])
  // Searchable by ID and display name, never by the capability wording.
  expect(options.searchText!(choices[42])).toContain("vendor/model-042")
  expect(options.searchText!(choices[42])).toContain("Model 42")
  expect(options.searchText!(choices[42])).not.toContain("images")
})

it("labels advertised, verified and unknown metadata differently", () => {
  expect(modelDetails({ id: "bare", label: "bare" })).toEqual([
    "Advertised: no capabilities listed · context unknown",
  ])
  expect(
    modelDetails(
      { id: "m", label: "m", vision: true, contextWindow: 1_048_576 },
      { verified: { structuredOutput: true, vision: false } }
    )
  ).toEqual([
    "Advertised: text unknown · images yes · structured output unknown · 1M context",
    "Verified by setup: structured output yes · images no",
  ])
  expect(formatTokens(200_000)).toBe("200K")
  expect(formatTokens(1_500_000)).toBe("1.5M")
  expect(formatTokens(512)).toBe("512")
})

it("marks the current model verified only when setup verified it for this target", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ data: [{ id: "current" }, { id: "other" }] })
    )
  )
  const detailsFor = async (current: Record<string, string>) => {
    const prompt = promptWith((question, choices) => {
      if (question === "Which AI provider?") return "openai"
      if (question === "What should the model analyze?") return false
      if (question.startsWith("Keep the current model")) return false
      return choices.find((choice) =>
        choice.label.startsWith("Keep the current")
      )!.value
    })
    vi.mocked(prompt.confirm).mockResolvedValue(false)
    await askAiProvider(prompt, current, false)
    const choices = vi.mocked(prompt.choosePaged).mock
      .calls[0][1] as Choice<unknown>[]
    return choices.find((choice) => choice.value === "current")!.detail
  }
  const base = {
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "k",
    AI_MODEL: "current",
  }
  const declaration = JSON.stringify({
    target: JSON.stringify(["openai", "current", "", "", "", "", "", false]),
    structuredOutput: true,
    vision: false,
  })
  expect(
    await detailsFor({ ...base, AI_MODEL_CAPABILITIES: declaration })
  ).toContain("Verified by setup: structured output yes · images no")
  expect((await detailsFor(base))!.join(" ")).not.toContain("Verified")
})

describe("the saved model catalog", () => {
  const gateway = { AI_PROVIDER: "gateway", AI_GATEWAY_API_KEY: "key" }
  const priced = {
    data: [
      {
        id: "vendor/flat",
        type: "language",
        pricing: { input: "0.000001", output: "0.000005" },
      },
      {
        id: "vendor/tiered",
        type: "language",
        pricing: {
          input: "0.00000125",
          output: "0.00001",
          input_tiers: [{ cost: "0.00000125", min: 0 }],
        },
      },
    ],
  }

  /** Picks `model`, and answers confirmations by what they ask. */
  function picking(model: string, answers: Record<string, boolean> = {}) {
    const prompt = promptWith((question) => {
      if (question === "Which AI provider?") return "gateway"
      if (question === "What should the model analyze?") return false
      return model
    })
    vi.mocked(prompt.confirm).mockImplementation(async (question, fallback) => {
      if (question.startsWith("Keep the current model")) return false
      for (const [start, answer] of Object.entries(answers))
        if (question.startsWith(start)) return answer
      return fallback ?? true
    })
    return prompt
  }

  it("reads a fresh catalog without calling the provider, and shows its prices", async () => {
    await loadCatalog(gateway, {
      fetcher: vi.fn(async () => Response.json(priced)),
    })
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    probe.mockResolvedValue({ structuredOutput: true, vision: false })
    const prompt = picking("vendor/flat", { "Use it": false })
    await askAiProvider(prompt, gateway, false)
    expect(fetcher).not.toHaveBeenCalled()
    const choices = vi.mocked(prompt.choosePaged).mock.calls[0][1]
    expect(choices[0].detail).toContain(
      "List price: $1.00 in · $5.00 out per 1M tokens"
    )
    expect(choices[1].detail!.join(" ")).toContain(
      "first tier; long prompts cost more"
    )
  })

  it("offers to refresh a stale catalog, and uses it as it is if declined", async () => {
    const stale = buildCatalog(
      gateway,
      priced.data.map((row) => parseModel("gateway", row)!),
      new Date(Date.now() - 2 * 24 * 3_600_000)
    )
    await writeCatalog(stale, cache)
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    probe.mockResolvedValue({ structuredOutput: true, vision: false })
    const prompt = picking("vendor/flat", {
      "The saved": false,
      "Use it": false,
    })
    await askAiProvider(prompt, gateway, false)
    expect(fetcher).not.toHaveBeenCalled()
    expect(
      vi
        .mocked(prompt.confirm)
        .mock.calls.some(([question]) =>
          /^The saved .* model list is from 2 days ago/.test(question)
        )
    ).toBe(true)
    const choices = vi.mocked(prompt.choosePaged).mock.calls[0][1]
    expect(choices[0].detail!.join(" ")).toContain("· stale")
  })

  it("saves a list price only when asked, merged into the existing table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(priced))
    )
    probe.mockResolvedValue({ structuredOutput: true, vision: false })
    const existing = {
      "openai:older": { inputPerMillion: 9, outputPerMillion: 9 },
    }
    const result = await askAiProvider(
      picking("vendor/flat"),
      { ...gateway, AI_MODEL_PRICES: JSON.stringify(existing) },
      false
    )
    expect(JSON.parse(result.AI_MODEL_PRICES!)).toEqual({
      ...existing,
      "vendor/flat": { inputPerMillion: 1, outputPerMillion: 5 },
    })
    expect(ratesFor(result)).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 5,
    })
  })

  it("does not default to a tiered price, or over a price the operator set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(priced))
    )
    probe.mockResolvedValue({ structuredOutput: true, vision: false })
    const tiered = picking("vendor/tiered")
    expect(
      (await askAiProvider(tiered, gateway, false)).AI_MODEL_PRICES
    ).toBeFalsy()
    const offer = vi
      .mocked(tiered.confirm)
      .mock.calls.find(([question]) => question.startsWith("Use it"))!
    expect(offer[1]).toBe(false)

    const mine = JSON.stringify({
      "vendor/flat": { inputPerMillion: 3, outputPerMillion: 4 },
    })
    const flat = picking("vendor/flat")
    expect(
      (await askAiProvider(flat, { ...gateway, AI_MODEL_PRICES: mine }, false))
        .AI_MODEL_PRICES
    ).toBe(mine)
    expect(
      vi
        .mocked(flat.confirm)
        .mock.calls.find(([question]) => question.startsWith("Replace"))![1]
    ).toBe(false)
  })

  it("leaves an unreadable AI_MODEL_PRICES alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(priced))
    )
    probe.mockResolvedValue({ structuredOutput: true, vision: false })
    const result = await askAiProvider(
      picking("vendor/flat"),
      { ...gateway, AI_MODEL_PRICES: "{broken" },
      false
    )
    expect(result.AI_MODEL_PRICES).toBe("{broken")
  })

  it("says plainly when a provider's list carries no prices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ id: "gpt-x" }] }))
    )
    const output = vi.spyOn(process.stdout, "write")
    const prompt = promptWith((question, choices) => {
      if (question === "Which AI provider?") return "openai"
      if (question === "What should the model analyze?") return false
      return choices.find((choice) => choice.label.startsWith("Keep"))!.value
    })
    await askAiProvider(prompt, { OPENAI_API_KEY: "k" }, false)
    expect(output.mock.calls.join("")).toContain(
      "model list carries no prices, so none are shown"
    )
  })
})
