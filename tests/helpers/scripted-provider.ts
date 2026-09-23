import type { LanguageModel } from "ai"

import { ANALYZE_IMAGE_SYSTEM } from "@/lib/ai/prompts/analyze-image"
import { ANALYZE_SPREADSHEET_SYSTEM } from "@/lib/ai/prompts/analyze-spreadsheet"
import { CLASSIFY_SYSTEM } from "@/lib/ai/prompts/classify-document"
import { DETECT_PII_SYSTEM } from "@/lib/ai/prompts/detect-pii"
import { VERIFY_SYSTEM } from "@/lib/ai/prompts/verify-detection"
import type {
  Classification,
  ColumnAnalysis,
  ImageAnalysis,
  ModelDetection,
  Verification,
} from "@/lib/ai/schemas/detection"

/**
 * A model provider that answers from a script.
 *
 * It is a real AI SDK language model (the `LanguageModelV4` a custom provider
 * implements), not a stand-in for `runStructured`. Everything between the
 * analysis code and the wire still runs: the gateway's configuration checks,
 * the throttle, `generateText`, `Output.object` and its schema validation,
 * usage recording and error classification. Only the network is gone, which
 * is what lets the orchestration run in CI with no key and no bill.
 *
 * The script is keyed by *task* rather than by call order. A document makes
 * one detect call per chunk, run concurrently, so the order is not something a
 * test should depend on. The task is read from the system prompt, which is
 * what a real model is given too.
 */

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>
type CallOptions = Parameters<LanguageModelV4["doGenerate"]>[0]
type GenerateResult = Awaited<ReturnType<LanguageModelV4["doGenerate"]>>

export type ScriptedTask =
  "classify" | "detect" | "verify" | "columns" | "image"

const SYSTEMS: [ScriptedTask, string][] = [
  ["classify", CLASSIFY_SYSTEM],
  ["detect", DETECT_PII_SYSTEM],
  ["verify", VERIFY_SYSTEM],
  ["columns", ANALYZE_SPREADSHEET_SYSTEM],
  ["image", ANALYZE_IMAGE_SYSTEM],
]

/** What the provider was asked, as a model would have received it. */
export type RecordedCall = {
  task: ScriptedTask
  system: string
  prompt: string
  /** For `detect`, the chunk of document text after the prompt's preamble. */
  content: string
  images: { mediaType: string }[]
  /** Whether structured output was requested with a JSON schema. */
  jsonSchema: boolean
  startedAt: number
  endedAt: number
}

/** A failure the way a provider SDK throws one, so the real classifier sees it. */
export type ScriptedFailure = {
  status: number
  message?: string
  retryAfterSeconds?: number
}

/**
 * An answer, or a function of the call that produces one. Returning a
 * `ScriptedFailure` from `fail` makes the call throw instead. `raw` answers are
 * sent to the SDK as text unchanged, for testing output that does not parse.
 */
export type Answer<T> = T | ((call: RecordedCall) => T | Promise<T>)

export type Script = {
  classify?: Answer<Classification>
  detect?: Answer<{ detections: ModelDetection[] }>
  verify?: Answer<Verification>
  columns?: Answer<ColumnAnalysis>
  image?: Answer<ImageAnalysis>
  /** Makes a task's calls fail. A function can fail some calls and not others. */
  fail?: Partial<
    Record<ScriptedTask, Answer<ScriptedFailure | null | undefined>>
  >
  /** Text returned verbatim instead of a JSON-encoded answer. */
  raw?: Partial<Record<ScriptedTask, string>>
  /** Milliseconds each call takes, so concurrency is observable. */
  latencyMs?: number
  usage?: { inputTokens: number; outputTokens: number }
}

/** Empty but valid, so an unscripted task behaves like a model that found nothing. */
const EMPTY: Record<ScriptedTask, unknown> = {
  classify: {
    documentType: "document",
    language: "English",
    sensitivityDensity: "low",
    notes: "",
  },
  detect: { detections: [] },
  verify: { verdicts: [] },
  columns: { columns: [] },
  image: { imageClass: "document", regions: [] },
}

class ScriptedProviderError extends Error {
  readonly statusCode: number
  readonly responseHeaders: Record<string, string>

  constructor(failure: ScriptedFailure) {
    super(failure.message ?? `Scripted provider error ${failure.status}`)
    this.name = "ScriptedProviderError"
    this.statusCode = failure.status
    this.responseHeaders =
      failure.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(failure.retryAfterSeconds) }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resolve<T>(answer: Answer<T>, call: RecordedCall): Promise<T> {
  return typeof answer === "function"
    ? await (answer as (call: RecordedCall) => T | Promise<T>)(call)
    : answer
}

function taskOf(system: string): ScriptedTask {
  const match = SYSTEMS.find(([, text]) => system.startsWith(text))
  if (!match) throw new Error("Scripted provider: unrecognised system prompt")
  return match[0]
}

function read(
  options: CallOptions
): Omit<RecordedCall, "startedAt" | "endedAt"> {
  let system = ""
  let prompt = ""
  const images: { mediaType: string }[] = []

  for (const message of options.prompt) {
    if (message.role === "system") system += message.content
    if (message.role !== "user") continue
    for (const part of message.content) {
      if (part.type === "text") prompt += part.text
      if (part.type === "file") images.push({ mediaType: part.mediaType })
    }
  }

  const marker = "\nCONTENT:\n"
  const at = prompt.indexOf(marker)

  return {
    task: taskOf(system),
    system,
    prompt,
    content: at === -1 ? prompt : prompt.slice(at + marker.length),
    images,
    jsonSchema:
      options.responseFormat?.type === "json" &&
      options.responseFormat.schema !== undefined,
  }
}

export class ScriptedLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4"
  readonly provider = "scripted"
  readonly modelId = "scripted-model"
  readonly supportedUrls = {}

  private script: Script = {}
  private inFlight = 0

  /** Every call, in the order each one finished. */
  readonly calls: RecordedCall[] = []
  /** The most calls that were ever in flight at once. */
  peakInFlight = 0

  setScript(script: Script): void {
    this.script = script
  }

  reset(): void {
    this.script = {}
    this.calls.length = 0
    this.inFlight = 0
    this.peakInFlight = 0
  }

  callsFor(task: ScriptedTask): RecordedCall[] {
    return this.calls.filter((call) => call.task === task)
  }

  async doGenerate(options: CallOptions): Promise<GenerateResult> {
    const call: RecordedCall = {
      ...read(options),
      startedAt: Date.now(),
      endedAt: 0,
    }

    this.inFlight += 1
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight)
    try {
      if (this.script.latencyMs) await sleep(this.script.latencyMs)

      const failWith = this.script.fail?.[call.task]
      const failure =
        failWith === undefined ? null : await resolve(failWith, call)
      if (failure) throw new ScriptedProviderError(failure)

      const scripted = this.script[call.task] as Answer<unknown> | undefined
      const text =
        this.script.raw?.[call.task] ??
        JSON.stringify(
          scripted === undefined
            ? EMPTY[call.task]
            : await resolve(scripted, call)
        )

      const usage = this.script.usage ?? { inputTokens: 10, outputTokens: 5 }
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: usage.inputTokens,
            noCache: usage.inputTokens,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: usage.outputTokens,
            text: usage.outputTokens,
            reasoning: undefined,
          },
        },
        warnings: [],
      }
    } finally {
      this.inFlight -= 1
      call.endedAt = Date.now()
      this.calls.push(call)
    }
  }

  async doStream(): Promise<never> {
    throw new Error(
      "The scripted provider does not stream; nothing here asks it to"
    )
  }
}

/**
 * The one instance a test file scripts, and the factory `vi.mock` installs in
 * place of `@/lib/ai/providers`:
 *
 *   vi.mock("@/lib/ai/providers", async (original) =>
 *     (await import("./helpers/scripted-provider")).scriptedProviders(original)
 *   )
 *
 * Provider *selection* stays real — the registry, the configured model id and
 * the capability declaration all behave as they do on an install. Only the
 * model at the end of it is swapped.
 */
export const scripted = new ScriptedLanguageModel()

export async function scriptedProviders(
  original: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const actual = (await original()) as Record<string, unknown>
  return {
    ...actual,
    providerConfigured: () => true,
    languageModel: async () => scripted,
  }
}
