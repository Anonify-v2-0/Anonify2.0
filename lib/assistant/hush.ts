import {
  aiConfigured,
  resolveModel,
  runStructured,
  type StructuredSkip,
} from "@/lib/ai/gateway"
import {
  HUSH_IMPROVE_SYSTEM,
  HUSH_SYSTEM,
  hushAnswerSchema,
  hushAskPrompt,
  hushImprovementSchema,
  hushImprovePrompt,
  type HushAskContext,
  type HushProposal,
} from "@/lib/ai/prompts/hush"
import { configuredCapabilities } from "@/lib/ai/providers/config"
import { spendAllows, spendStatus } from "@/lib/ai/spend"
import { readNormalized } from "@/lib/documents/normalized-store"
import {
  compilePattern,
  PatternBudgetError,
  PatternError,
  type PatternSpec,
} from "@/lib/redaction/patterns"
import type { RuleTarget } from "@/lib/redaction/rules"
import {
  diffMatches,
  previewMatches,
  type MatchPreview,
  type MatchSample,
} from "@/lib/redaction/search"

/**
 * Hush on the server: asking the configured model, and checking its answer
 * against the document before the reviewer sees it.
 *
 * The model is the configured analysis provider, called through the same
 * `runStructured` as analysis — so it is paced by the same gate, bound by the
 * same daily spend cap, and every call lands in `AiUsage` against the document
 * it was about. Nothing Hush proposes is applied here; each proposal is
 * compiled and previewed so the panel can show its matches, and that is all.
 */

export type HushUnavailable = "not-configured" | "unsupported" | "budget"

export type HushStatus =
  | { available: true; model: string }
  | { available: false; reason: HushUnavailable }

export async function hushStatus(): Promise<HushStatus> {
  if (!aiConfigured()) return { available: false, reason: "not-configured" }
  if (!configuredCapabilities().structuredOutput) {
    return { available: false, reason: "unsupported" }
  }
  if (!spendAllows(await spendStatus())) {
    return { available: false, reason: "budget" }
  }
  return { available: true, model: resolveModel() }
}

export class HushError extends Error {
  constructor(
    readonly reason: HushUnavailable | StructuredSkip | "no-answer",
    message: string
  ) {
    super(message)
    this.name = "HushError"
  }
}

const SKIP_MESSAGES: Partial<Record<StructuredSkip, string>> = {
  "rate-limit":
    "The AI provider is rate-limiting this instance. Try again in a moment.",
  budget: "The AI provider reports that its budget or credit is exhausted.",
  authorization: "The AI provider rejected this instance's key.",
  timeout: "The AI provider did not answer in time.",
  "invalid-output":
    "The AI provider returned something Hush could not read. Try rephrasing.",
}

async function ready(): Promise<void> {
  const status = await hushStatus()
  if (status.available) return
  throw new HushError(
    status.reason,
    status.reason === "not-configured"
      ? "Hush needs an AI provider, and this instance has none configured."
      : status.reason === "unsupported"
        ? "The configured model cannot return structured answers, which Hush needs."
        : "This instance has reached its daily AI spend cap."
  )
}

function failed(skip: StructuredSkip | undefined): HushError {
  const reason = skip ?? "no-answer"
  return new HushError(
    reason,
    (skip && SKIP_MESSAGES[skip]) ??
      "Hush could not get an answer from the AI provider."
  )
}

export type CheckedProposal = HushProposal & {
  /** Present when the pattern compiled and ran within budget. */
  preview?: MatchPreview
  /** Why it cannot be used, when it cannot. */
  problem?: string
}

function specOfProposal(proposal: HushProposal): PatternSpec {
  return {
    kind: proposal.kind,
    pattern: proposal.pattern,
    matchCase: proposal.matchCase,
    wholeWord: proposal.wholeWord,
  }
}

/**
 * Previews a proposed rule against the document, or says why it cannot run.
 *
 * A proposal that does not compile, or that would run out of budget, is shown
 * with its problem rather than dropped: the reviewer asked for something, and
 * silently returning less than the model said is how an assistant loses trust.
 */
async function check(
  target: RuleTarget,
  proposal: HushProposal
): Promise<CheckedProposal> {
  try {
    const compiled = compilePattern(specOfProposal(proposal))
    const preview = await previewMatches(readNormalized(target), compiled, {
      samples: 8,
    })
    return { ...proposal, preview }
  } catch (error) {
    if (error instanceof PatternError || error instanceof PatternBudgetError) {
      return { ...proposal, problem: error.message }
    }
    throw error
  }
}

export async function askHush(input: {
  documentId: string
  target: RuleTarget
  context: HushAskContext
}): Promise<{ answer: string; proposals: CheckedProposal[] }> {
  await ready()

  const result = await runStructured({
    task: "assistant",
    documentId: input.documentId,
    system: HUSH_SYSTEM,
    prompt: hushAskPrompt(input.context),
    schema: hushAnswerSchema,
  })
  if (!result.output) throw failed(result.skipped)

  const proposals: CheckedProposal[] = []
  for (const proposal of result.output.proposals) {
    // A batch scope on a lone document is a promise about files that do not
    // exist; the model was told, and is corrected here if it did it anyway.
    const scoped =
      proposal.scope === "batch" && !input.context.inBatch
        ? { ...proposal, scope: "document" as const }
        : proposal
    proposals.push(await check(input.target, scoped))
  }

  return { answer: result.output.answer, proposals }
}

export type Improvement = {
  spec: PatternSpec
  explanation: string
  diff?: {
    before: number
    after: number
    gainedCount: number
    lostCount: number
    gained: MatchSample[]
    lost: MatchSample[]
  }
  problem?: string
}

/**
 * "Improve with Hush": a tightened version of a RegEx rule, and exactly what
 * it would change in this document — the matches gained and the matches lost
 * — so the reviewer decides with the consequences in front of them. The rule
 * itself is not touched; accepting is an ordinary rule edit.
 */
export async function improveWithHush(input: {
  documentId: string
  target: RuleTarget
  spec: PatternSpec
  accepted: string[]
  rejected: string[]
}): Promise<Improvement> {
  const current = compilePattern(input.spec)
  await ready()

  const result = await runStructured({
    task: "assistant-improve",
    documentId: input.documentId,
    system: HUSH_IMPROVE_SYSTEM,
    prompt: hushImprovePrompt({
      ...input.spec,
      accepted: input.accepted,
      rejected: input.rejected,
    }),
    schema: hushImprovementSchema,
  })
  if (!result.output) throw failed(result.skipped)

  const spec: PatternSpec = {
    kind: "regex",
    pattern: result.output.pattern,
    matchCase: result.output.matchCase,
    wholeWord: result.output.wholeWord,
  }

  try {
    const next = compilePattern(spec)
    const diff = await diffMatches(
      readNormalized(input.target),
      current,
      next,
      {
        samples: 10,
      }
    )
    return { spec, explanation: result.output.explanation, diff }
  } catch (error) {
    if (error instanceof PatternError || error instanceof PatternBudgetError) {
      return {
        spec,
        explanation: result.output.explanation,
        problem: error.message,
      }
    }
    throw error
  }
}
