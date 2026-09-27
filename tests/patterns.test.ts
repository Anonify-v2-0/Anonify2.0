import { describe, expect, it } from "vitest"

import { findOccurrences } from "@/lib/documents/shared/text"
import {
  compilePattern,
  createBudget,
  escapeRegex,
  isWholeWord,
  PATTERN_MAX_LENGTH,
  PatternBudgetError,
  PatternError,
  patternProblem,
  RULE_MATCH_LIMIT,
  specOf,
  storedNormalizedPattern,
  type PatternSpec,
} from "@/lib/redaction/patterns"

/**
 * A reviewer's pattern runs on the server against every page of every
 * document it reaches, so these are the tests that it cannot be turned into a
 * denial of service, cannot half-apply, and matches what search showed.
 */

function regex(pattern: string, options: Partial<PatternSpec> = {}): PatternSpec {
  return { kind: "regex", pattern, matchCase: false, wholeWord: false, ...options }
}

function literal(pattern: string, options: Partial<PatternSpec> = {}): PatternSpec {
  return { kind: "literal", pattern, matchCase: false, wholeWord: false, ...options }
}

function matched(spec: PatternSpec, text: string): string[] {
  return compilePattern(spec)
    .find(text)
    .map((range) => text.slice(range.start, range.end))
}

describe("patterns that would backtrack", () => {
  // The classics. Under a backtracking engine each of these takes exponential
  // time on the input below; under RE2 they are linear, and the test would
  // time out long before it failed if that ever stopped being true.
  const catastrophic = ["(a+)+$", "(a|aa)+$", "(a|a?)+b", "(.*a){20}$", "^(\\w+\\s?)+$"]
  const input = "a".repeat(50_000) + "!"

  for (const pattern of catastrophic) {
    it(`runs ${pattern} in linear time`, () => {
      const started = performance.now()
      compilePattern(regex(pattern)).find(input, createBudget())
      expect(performance.now() - started).toBeLessThan(2_000)
    })
  }

  it("refuses backreferences, which need backtracking, with a sentence that says so", () => {
    expect(() => compilePattern(regex("(a)\\1"))).toThrowError(PatternError)
    expect(patternProblem(regex("(a)\\1"))).toMatch(/backreferences/i)
  })

  it("refuses lookahead and lookbehind", () => {
    expect(patternProblem(regex("foo(?=bar)"))).toMatch(/lookahead and lookbehind/i)
    expect(patternProblem(regex("(?<!x)foo"))).toMatch(/lookahead and lookbehind/i)
  })

  it("refuses a pattern longer than the limit", () => {
    const problem = patternProblem(regex("a".repeat(PATTERN_MAX_LENGTH + 1)))
    expect(problem).toMatch(new RegExp(String(PATTERN_MAX_LENGTH)))
    expect(patternProblem(regex("a".repeat(PATTERN_MAX_LENGTH)))).toBeNull()
  })

  it("refuses an invalid pattern and an empty one", () => {
    expect(patternProblem(regex("["))).toMatch(/not a valid pattern/i)
    expect(patternProblem(regex("   "))).toMatch(/enter something/i)
  })

  it("refuses a pattern that can match nothing, since it would match everywhere", () => {
    for (const pattern of ["a*", "\\d{0,3}", "(x)?", "|"]) {
      expect(() => compilePattern(regex(pattern))).toThrowError(/empty string/)
    }
  })
})

describe("the budget", () => {
  it("stops a pattern that matches more than the limit, rather than returning part", () => {
    const text = "x ".repeat(RULE_MATCH_LIMIT + 5)
    expect(() => compilePattern(regex("x")).find(text, createBudget())).toThrowError(
      PatternBudgetError
    )
  })

  it("is shared across pages, so a document is budgeted as a whole", () => {
    const budget = createBudget({ matchLimit: 5 })
    const compiled = compilePattern(literal("ab"))
    compiled.find("ab ab ab", budget)
    expect(() => compiled.find("ab ab ab", budget)).toThrowError(/more than/)
  })

  it("fails loudly on time, counting only the time spent matching", () => {
    // Every reading of the clock moves it 30ms, so each page "takes" 30ms of
    // matching; time spent between pages — reading storage — never counts.
    let clock = 0
    const budget = createBudget({ limitMs: 100, now: () => (clock += 30) })
    const compiled = compilePattern(regex("\\d+"))

    compiled.find("1 2 3", budget)
    compiled.find("4 5 6", budget)
    compiled.find("7 8 9", budget)
    clock += 10_000
    expect(budget.spentMs).toBe(90)

    try {
      compiled.find("10 11", budget)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PatternBudgetError)
      expect((error as PatternBudgetError).reason).toBe("time")
    }
  })
})

describe("matching", () => {
  it("matches a literal exactly as rules always have", () => {
    const text = "John Smith met JOHN SMITH and john smithson"
    const ranges = compilePattern(literal("john smith")).find(text)
    expect(ranges).toEqual(findOccurrences(text, "john smith"))
  })

  it("honours match case for both kinds", () => {
    expect(matched(literal("Smith", { matchCase: true }), "Smith smith")).toEqual(["Smith"])
    expect(matched(regex("smith"), "Smith smith")).toEqual(["Smith", "smith"])
    expect(matched(regex("smith", { matchCase: true }), "Smith smith")).toEqual(["smith"])
  })

  it("finds whole words by Unicode letters, not ASCII ones", () => {
    const text = "un café, cafés et cafe"
    expect(matched(literal("café", { wholeWord: true }), text)).toEqual(["café"])
    expect(matched(literal("cat", { wholeWord: true }), "cat catalog concat cat.")).toEqual([
      "cat",
      "cat",
    ])
    expect(isWholeWord("名前です", 0, 2)).toBe(false)
    expect(isWholeWord("名前 です", 0, 2)).toBe(true)
  })

  it("reports offsets in UTF-16 code units, the way page text is indexed", () => {
    const text = "🙂 EMP-00123 é EMP-00456"
    const ranges = compilePattern(regex("EMP-\\d{5}")).find(text)
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      "EMP-00123",
      "EMP-00456",
    ])
  })

  it("treats ^ and $ as line boundaries", () => {
    expect(matched(regex("^ref \\d+$"), "ref 1\nnot ref 2\nref 3")).toEqual(["ref 1", "ref 3"])
  })

  it("never reports a zero-length match", () => {
    for (const range of compilePattern(regex("\\bx?y")).find("y xy zy")) {
      expect(range.end).toBeGreaterThan(range.start)
    }
  })

  it("escapes a literal for use as a RegEx", () => {
    const value = "a.b*c(1)[x]"
    expect(matched(regex(escapeRegex(value)), `${value} axb`)).toEqual([value])
  })
})

describe("rule rows", () => {
  it("reads a rule written before kinds existed as a case-insensitive literal", () => {
    expect(specOf({ pattern: "John Smith" })).toEqual(literal("John Smith"))
  })

  it("folds a literal as before, and keeps a RegEx exactly as written", () => {
    expect(storedNormalizedPattern(literal("  John   SMITH "))).toBe("john smith")
    expect(storedNormalizedPattern(regex("\\D+X"))).toBe("\\D+X")
  })
})
