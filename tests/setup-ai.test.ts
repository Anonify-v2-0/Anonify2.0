import { afterEach, expect, it, vi } from "vitest"
import { askAiProvider } from "../scripts/setup-ai"
import { Prompter, type Choice } from "../scripts/tty"
import { configuredCapabilities } from "@/lib/ai/providers/config"

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock("@/lib/ai/providers/probe", () => ({ probeModel: probe }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  probe.mockReset()
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
  return {
    interactive: true,
    choose: vi.fn(choose),
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
