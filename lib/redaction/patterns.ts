import { RE2JS } from "re2js"

import { findOccurrences, type CharRange } from "@/lib/documents/shared/text"

/**
 * Patterns a reviewer writes: what search looks for, and what a rule redacts.
 *
 * One compiler for both, and deliberately so. "Redact all matches" turns a
 * search into a rule, and the reviewer has just been shown what the search
 * found — a rule that matched differently would redact something they never
 * saw, or leave something they did.
 *
 * A RegEx here is a reviewer's pattern run on the server against every page of
 * every document in its scope, so a pattern that backtracks catastrophically is
 * a denial of service with a text box in front of it. It is compiled with
 * RE2JS, a port of RE2: matching is linear in the text whatever the pattern,
 * and the constructs that need backtracking — backreferences, lookaround — do
 * not compile at all. The length limit and the budget below are belt and
 * braces on top of that, not the defence itself.
 *
 * Isomorphic on purpose. The rule dialog validates as the reviewer types with
 * the same code the server will run, so a pattern the browser accepted is not
 * refused a moment later for a reason the browser could have given.
 */

export const PATTERN_KINDS = ["literal", "regex"] as const

export type PatternKind = (typeof PATTERN_KINDS)[number]

export type PatternSpec = {
  kind: PatternKind
  pattern: string
  /** Off by default: a name is the same name in capitals. */
  matchCase: boolean
  /** Only matches that neither start nor end inside a word. */
  wholeWord: boolean
}

/** Longer than any identifier shape anybody writes by hand, short enough to read. */
export const PATTERN_MAX_LENGTH = 500

/**
 * Time a rule may spend matching in one document, and the matches it may make.
 *
 * With a linear engine the time is a function of the document's length, so the
 * budget is only reached by a document far larger than anything the quotas let
 * in — which is exactly the case where stopping is right. The match cap catches
 * the other mistake: `\w+` is a perfectly safe pattern that would redact every
 * word, and ten thousand accepted redactions nobody reviewed is a failure even
 * when it is fast.
 */
export const RULE_BUDGET_MS = 5_000
export const RULE_MATCH_LIMIT = 10_000

export type PatternErrorCode = "empty" | "too-long" | "syntax" | "matches-empty"

/** A pattern that cannot be used, with a sentence the reviewer can act on. */
export class PatternError extends Error {
  constructor(
    readonly code: PatternErrorCode,
    message: string
  ) {
    super(message)
    this.name = "PatternError"
  }
}

export type BudgetExceeded = "time" | "matches"

/**
 * Matching stopped before it finished.
 *
 * Thrown rather than returned so a caller cannot use half an answer by
 * accident: a rule that ran out of budget on page 300 must not leave pages 1
 * to 299 redacted and the rest untouched while claiming to be "everywhere".
 */
export class PatternBudgetError extends Error {
  constructor(readonly reason: BudgetExceeded) {
    super(
      reason === "time"
        ? "This pattern took too long to run against the document, so nothing was applied. Make it more specific."
        : `This pattern matches more than ${RULE_MATCH_LIMIT.toLocaleString("en")} places, so nothing was applied. Make it more specific.`
    )
    this.name = "PatternBudgetError"
  }
}

/** Matching time and match count, shared across every page of one document. */
export type PatternBudget = {
  spentMs: number
  matches: number
  readonly limitMs: number
  readonly matchLimit: number
  readonly now: () => number
}

export function createBudget(
  options: { limitMs?: number; matchLimit?: number; now?: () => number } = {}
): PatternBudget {
  return {
    spentMs: 0,
    matches: 0,
    limitMs: options.limitMs ?? RULE_BUDGET_MS,
    matchLimit: options.matchLimit ?? RULE_MATCH_LIMIT,
    now: options.now ?? (() => performance.now()),
  }
}

export type CompiledPattern = {
  readonly spec: PatternSpec
  /**
   * Every match in `text`, in order and without overlaps. Zero-length matches
   * are never reported: there is nothing in them to redact.
   */
  find(text: string, budget?: PatternBudget): CharRange[]
}

const WORD = /[\p{L}\p{N}\p{M}_]/u

function codePointBefore(text: string, index: number): string {
  if (index <= 0) return ""
  const low = text.charCodeAt(index - 1)
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    return text.slice(index - 2, index)
  }
  return text[index - 1]
}

function codePointAt(text: string, index: number): string {
  const point = text.codePointAt(index)
  return point === undefined ? "" : String.fromCodePoint(point)
}

/**
 * Whether a match stands on its own as a word.
 *
 * Not RE2's `\b`, which only knows ASCII: "café" followed by a space would not
 * end on a boundary, and a reviewer searching a French contract for a whole
 * word would get nothing and conclude it is not there.
 */
export function isWholeWord(text: string, start: number, end: number): boolean {
  if (end <= start) return false
  const before = codePointBefore(text, start)
  const after = codePointAt(text, end)
  return !(before && WORD.test(before)) && !(after && WORD.test(after))
}

/** Normalizes what a reviewer typed, and refuses what cannot be used. */
export function validatePattern(spec: PatternSpec): PatternSpec {
  const { pattern } = spec
  if (!pattern.trim()) {
    throw new PatternError("empty", "Enter something to match.")
  }
  if (pattern.length > PATTERN_MAX_LENGTH) {
    throw new PatternError(
      "too-long",
      `Patterns are limited to ${PATTERN_MAX_LENGTH} characters.`
    )
  }
  return spec
}

function compileRegex(spec: PatternSpec): RE2JS {
  let compiled: RE2JS
  try {
    compiled = RE2JS.compile(
      spec.pattern,
      // Multiline so `^` and `$` mean the start and end of a line, which is
      // what anybody writing a pattern against a page of text expects.
      RE2JS.MULTILINE | (spec.matchCase ? 0 : RE2JS.CASE_INSENSITIVE)
    )
  } catch (error) {
    throw new PatternError("syntax", describeSyntaxError(error))
  }

  // A pattern that matches nothing at all matches between every pair of
  // characters. Refused outright rather than filtered, because the reviewer
  // almost certainly meant something narrower and should be told so.
  if (compiled.matcher("").find()) {
    throw new PatternError(
      "matches-empty",
      "This pattern can match an empty string, so it would match everywhere. Make at least one part of it required."
    )
  }

  return compiled
}

/**
 * The engine's message, made about the reviewer's pattern rather than about
 * the engine. The unsupported constructs get their own sentence because they
 * are the ones somebody who knows JavaScript or PCRE will reach for first.
 */
function describeSyntaxError(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (/\\[1-9]/.test(message)) {
    return "Backreferences such as \\1 are not supported: they cannot be matched safely on the server."
  }
  if (/\(\?[=!<]/.test(message)) {
    return "Lookahead and lookbehind are not supported: they cannot be matched safely on the server."
  }
  const detail = message.replace(/^error parsing regexp:\s*/i, "")
  return detail ? `Not a valid pattern: ${detail}.` : "Not a valid pattern."
}

function charge(
  budget: PatternBudget | undefined,
  startedAt: number,
  found: number
) {
  if (!budget) return
  budget.spentMs += budget.now() - startedAt
  budget.matches += found
  if (budget.matches > budget.matchLimit)
    throw new PatternBudgetError("matches")
  if (budget.spentMs > budget.limitMs) throw new PatternBudgetError("time")
}

/**
 * Compiles a pattern for repeated use.
 *
 * A literal is matched the way rules have always matched one — by
 * `findOccurrences`, case-insensitively unless asked otherwise — so a rule
 * written before this existed and the same rule written after it redact the
 * same characters.
 */
export function compilePattern(input: PatternSpec): CompiledPattern {
  const spec = validatePattern(input)

  if (spec.kind === "literal") {
    return {
      spec,
      find(text, budget) {
        const startedAt = budget?.now() ?? 0
        let ranges = findOccurrences(text, spec.pattern, spec.matchCase)
        if (spec.wholeWord) {
          ranges = ranges.filter((range) =>
            isWholeWord(text, range.start, range.end)
          )
        }
        charge(budget, startedAt, ranges.length)
        return ranges
      },
    }
  }

  const regex = compileRegex(spec)

  return {
    spec,
    find(text, budget) {
      const startedAt = budget?.now() ?? 0
      const ranges: CharRange[] = []
      const matcher = regex.matcher(text)
      while (matcher.find()) {
        const start = matcher.start()
        const end = matcher.end()
        if (end <= start) continue
        if (spec.wholeWord && !isWholeWord(text, start, end)) continue
        ranges.push({ start, end })
        // Checked inside the loop too: a page is bounded, but a pattern that
        // matches every character of it would build the whole list first.
        if (budget && budget.matches + ranges.length > budget.matchLimit) {
          throw new PatternBudgetError("matches")
        }
      }
      charge(budget, startedAt, ranges.length)
      return ranges
    },
  }
}

/** The same compile, answered as a sentence rather than an exception. */
export function patternProblem(spec: PatternSpec): string | null {
  try {
    compilePattern(spec)
    return null
  } catch (error) {
    return error instanceof PatternError
      ? error.message
      : "Not a valid pattern."
  }
}

/** Escapes a literal for use inside a RegEx, for turning a search into one. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * How a rule remembers its pattern in the one column older rows have.
 *
 * A literal is folded the way it always was, which is what the batch view and
 * duplicate checks compare. A RegEx is kept exactly as written: lower-casing
 * `\D` into `\d` would be a different pattern.
 */
export function storedNormalizedPattern(spec: PatternSpec): string {
  return spec.kind === "literal"
    ? spec.pattern.trim().toLowerCase().replace(/\s+/g, " ")
    : spec.pattern
}

/** Reads a rule row, whatever era it was written in, back into a spec. */
export function specOf(row: {
  pattern: string
  kind?: string | null
  matchCase?: boolean | null
  wholeWord?: boolean | null
}): PatternSpec {
  return {
    kind: row.kind === "regex" ? "regex" : "literal",
    pattern: row.pattern,
    matchCase: row.matchCase ?? false,
    wholeWord: row.wholeWord ?? false,
  }
}

/** A short human description of the options, for rule rows and previews. */
export function describeSpec(spec: PatternSpec): string {
  const parts: string[] = [spec.kind === "regex" ? "RegEx" : "Text"]
  if (spec.matchCase) parts.push("match case")
  if (spec.wholeWord) parts.push("whole word")
  return parts.join(" · ")
}
