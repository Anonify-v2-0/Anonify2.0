import { readFileSync } from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { makeImageFixture } from "./fixtures"
import { REDACTION_CATEGORIES } from "@/types/redaction"
import type { NormalizedDocument } from "@/types/document"

/**
 * The production provider path, against a real model running locally.
 *
 * `tests/analysis-orchestration.test.ts` answers every orchestration question
 * with a scripted model, and that is the right tool for them: a real model
 * cannot be made to hallucinate on cue. What a script cannot tell you is
 * whether the adapter a self-hosted install actually uses still carries a
 * structured call end to end — the provider registry, the OpenAI-compatible
 * transport, JSON-schema output, an image attachment, the Zod parse, usage
 * accounting, and a provider failure arriving as a skip rather than a throw.
 *
 * So these tests assert the contract and never the semantics. Whether Gemma
 * thinks a name is sensitive is not something to fail a build over; whether its
 * answer validates, is located in the source, and is accounted for is.
 *
 * They need a running Ollama with the pinned model pulled, so they are opt-in:
 *
 *   ollama pull gemma3:4b
 *   ANONIFY_OLLAMA_TESTS=1 pnpm exec vitest run tests/ollama-contract.test.ts
 *
 * `.github/workflows/local-model.yml` runs them weekly against the pinned
 * runtime and model digest in tests/fixtures/ollama/model.json.
 */

const createUsage = vi.hoisted(() => vi.fn(async () => ({})))

vi.mock("@/lib/database/prisma", () => ({
  prisma: {
    aiUsage: {
      create: createUsage,
      groupBy: async () => [],
    },
  },
}))

const { analyzeDocument, analyzeImageRegions } =
  await import("@/lib/ai/analyze")
const { runStructured, skipIsFailure } = await import("@/lib/ai/gateway")
const { capabilityDeclaration, DEFAULT_OLLAMA_URL } =
  await import("@/lib/ai/providers/config")
const { discoverModels } = await import("@/lib/ai/providers/discovery")
const { probeModel } = await import("@/lib/ai/providers/probe")
const { CLASSIFY_SYSTEM, classifyPrompt } =
  await import("@/lib/ai/prompts/classify-document")
const { classificationSchema } = await import("@/lib/ai/schemas/detection")
const { resetThrottles } = await import("@/lib/services/throttle")

const pinned: { model: string } = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "fixtures", "ollama", "model.json"),
    "utf8"
  )
)

const MODEL = process.env.OLLAMA_TEST_MODEL?.trim() || pinned.model
const BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_URL

/** CPU inference on a shared runner; the first call also loads the model. */
const MODEL_TIMEOUT = 10 * 60_000

function configure(overrides: Record<string, string> = {}) {
  const env = {
    AI_PROVIDER: "ollama",
    AI_MODEL: MODEL,
    OLLAMA_BASE_URL: BASE_URL,
    ...overrides,
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return env
}

/** What `pnpm setup` writes once it has verified the model. */
function declare(
  env: Record<string, string>,
  capabilities: { structuredOutput: boolean; vision: boolean }
) {
  vi.stubEnv("AI_MODEL_CAPABILITIES", capabilityDeclaration(env, capabilities))
}

const LETTER = [
  "Referral letter",
  "",
  "Dear Dr. Okafor,",
  "",
  "I am referring my patient, Maria Lopez (date of birth 14/03/1981), who lives",
  "at 22 Harbour Lane, Leeds. She can be reached at maria.lopez@example.com.",
  "",
  "Kind regards,",
  "Dr. Sam Whitfield",
].join("\n")

describe.runIf(process.env.ANONIFY_OLLAMA_TESTS)(
  `Ollama provider contract (${MODEL})`,
  () => {
    beforeAll(() => {
      for (const name of [
        "AI_MODEL_CAPABILITIES",
        "ANONIFY_AI_DAILY_SPEND_USD",
        "ANONIFY_AI_CONCURRENCY",
        "ANONIFY_AI_REQUESTS_PER_MINUTE",
        "ANONIFY_AI_MAX_ATTEMPTS",
      ]) {
        vi.stubEnv(name, "")
      }
      const env = configure()
      // Declared up front so each test can run on its own; the probe test
      // below is what establishes that the declaration is true.
      declare(env, { structuredOutput: true, vision: true })
    })

    afterAll(() => {
      vi.unstubAllEnvs()
    })

    it("is discovered as an installed local model that reads images", async () => {
      const models = await discoverModels(configure())
      const model = models.find((candidate) => candidate.id === MODEL)

      expect(model, `${MODEL} is not installed`).toBeDefined()
      expect(model).toMatchObject({ textOutput: true, vision: true })
      expect(model?.unavailable).toBeUndefined()
    }, 60_000)

    it(
      "passes the verification setup runs before enabling it",
      async () => {
        const result = await probeModel(configure())

        expect(result).toEqual({ structuredOutput: true, vision: true })
      },
      MODEL_TIMEOUT
    )

    it(
      "returns structured output that validates, and accounts for it",
      async () => {
        resetThrottles()
        createUsage.mockClear()

        const result = await runStructured({
          task: "classify",
          documentId: "doc_ollama",
          system: CLASSIFY_SYSTEM,
          prompt: classifyPrompt(LETTER),
          schema: classificationSchema,
        })

        expect(result.skipped).toBeUndefined()
        expect(classificationSchema.safeParse(result.output).success).toBe(true)
        expect(result.inputTokens).toBeGreaterThan(0)
        expect(result.outputTokens).toBeGreaterThan(0)

        // Usage is qualified by provider, so a local model's tokens can never
        // be priced as a hosted model with the same name.
        expect(createUsage).toHaveBeenCalledWith({
          data: expect.objectContaining({
            documentId: "doc_ollama",
            task: "classify",
            model: `ollama:${MODEL}`,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          }),
        })
      },
      MODEL_TIMEOUT
    )

    it(
      "carries a whole analysis pass, and every suggestion is in the source",
      async () => {
        resetThrottles()
        const model: NormalizedDocument = {
          documentId: "doc_ollama",
          kind: "txt",
          pages: [
            { number: 1, width: 612, height: 792, text: LETTER, spans: [] },
          ],
        }

        const result = await analyzeDocument("doc_ollama", model)

        // Every model call the pass wanted to make was made and parsed.
        expect(result.degraded).toBeNull()
        expect(result.classification).not.toBeNull()

        // The pattern pass ran alongside it.
        expect(result.detections.map((d) => d.text)).toContain(
          "maria.lopez@example.com"
        )

        // Invariant 5 against a model nobody scripted: whatever it proposed,
        // what survived is exactly what the document says, where it says it.
        for (const detection of result.detections) {
          expect(REDACTION_CATEGORIES).toContain(detection.category)
          expect(detection.page).toBe(1)
          expect(LETTER.slice(detection.start, detection.end)).toBe(
            detection.text
          )
        }
      },
      MODEL_TIMEOUT
    )

    it(
      "reads an attached image and answers inside the page",
      async () => {
        resetThrottles()
        const width = 400
        const height = 300
        const model: NormalizedDocument = {
          documentId: "doc_ollama",
          kind: "image",
          pages: [{ number: 1, width, height, text: "", spans: [] }],
        }

        const { regions, skipped } = await analyzeImageRegions(
          "doc_ollama",
          model,
          { data: await makeImageFixture(), mediaType: "image/png" }
        )

        expect(skipped).toBeUndefined()
        for (const region of regions) {
          const box = region.boundingBox!
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.y).toBeGreaterThanOrEqual(0)
          expect(box.x).toBeLessThanOrEqual(width)
          expect(box.y).toBeLessThanOrEqual(height)
        }
      },
      MODEL_TIMEOUT
    )

    describe("when the provider fails", () => {
      const call = {
        task: "classify",
        documentId: "doc_ollama",
        system: CLASSIFY_SYSTEM,
        prompt: classifyPrompt(LETTER),
        schema: classificationSchema,
      }

      afterAll(() => {
        // Back to the real model for anything that runs after.
        declare(configure(), { structuredOutput: true, vision: true })
      })

      it(
        "reports a model the server does not have as a skip, not a throw",
        async () => {
          resetThrottles()
          createUsage.mockClear()
          const env = configure({ AI_MODEL: "anonify-no-such-model:latest" })
          declare(env, { structuredOutput: true, vision: true })

          const result = await runStructured(call)

          expect(result.output).toBeNull()
          expect(skipIsFailure(result.skipped)).toBe(true)
          expect(createUsage).not.toHaveBeenCalled()
        },
        MODEL_TIMEOUT
      )

      it(
        "reports a server that is not running as a provider failure",
        async () => {
          resetThrottles()
          // Port 9 is discard: nothing listens there, so the connection is
          // refused rather than left to time out.
          const env = configure({ OLLAMA_BASE_URL: "http://127.0.0.1:9" })
          declare(env, { structuredOutput: true, vision: true })

          const result = await runStructured(call)

          expect(result).toMatchObject({ output: null, skipped: "provider" })
        },
        MODEL_TIMEOUT
      )
    })
  }
)
