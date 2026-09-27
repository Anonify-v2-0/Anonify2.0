import {
  compilePattern,
  escapeRegex,
  type PatternSpec,
} from "@/lib/redaction/patterns"

/**
 * Learning a rule from what the reviewer is doing, without asking a model.
 *
 * A reviewer who redacts EMP-00123, EMP-00456 and EMP-00789 by hand has told
 * us what an employee number looks like three times. Turning that into
 * `EMP-\d{5}` is not a judgement anybody needs a model for: it is reading the
 * shape the values share. Done here, it costs nothing, sends nothing anywhere,
 * and works on an instance with no AI provider at all.
 *
 * What it will not do is generalise a shape that has nothing to hold on to.
 * "John Smith", "Jane Doe" and "Ann Lee" share a shape — two capitalised
 * words — and so does every other pair of capitalised words in the language.
 * A shape is only offered when it is anchored: it contains digits, or a piece
 * of literal text every example shares, so the rule it becomes matches values
 * like these rather than text like these.
 */

/** How many hand-made redactions of one shape before Hush offers a rule. */
export const LEARN_THRESHOLD = 3

type TokenClass = "letters" | "digits" | "space" | "symbol"

type Token = { cls: TokenClass; text: string }

const LETTER = /\p{L}/u
const DIGIT = /\p{Nd}/u
const SPACE = /\s/u

function classOf(char: string): TokenClass {
  if (DIGIT.test(char)) return "digits"
  if (LETTER.test(char)) return "letters"
  if (SPACE.test(char)) return "space"
  return "symbol"
}

export function tokenize(value: string): Token[] {
  const tokens: Token[] = []
  for (const char of value.trim()) {
    const cls = classOf(char)
    const last = tokens.at(-1)
    // Symbols never merge: `--` and `-` are different shapes, and each one is
    // kept as the literal character it is.
    if (last && last.cls === cls && cls !== "symbol") {
      last.text += char
    } else {
      tokens.push({ cls, text: char })
    }
  }
  return tokens
}

/** The part of a value's shape that must agree for two values to be alike. */
export function signature(value: string): string {
  return tokenize(value)
    .map((token) => (token.cls === "symbol" ? `s:${token.text}` : token.cls[0]))
    .join("|")
}

function lengths(texts: string[]): string {
  const counts = texts.map((text) => [...text].length)
  const min = Math.min(...counts)
  const max = Math.max(...counts)
  if (min === max) return min === 1 ? "" : `{${min}}`
  return `{${min},${max}}`
}

function letterClass(texts: string[]): string {
  const ascii = texts.every((text) => /^[A-Za-z]+$/.test(text))
  if (!ascii) return "\\p{L}"
  if (texts.every((text) => text === text.toUpperCase())) return "[A-Z]"
  if (texts.every((text) => text === text.toLowerCase())) return "[a-z]"
  return "[A-Za-z]"
}

export type LearnedShape = {
  /** Stable for a shape, so a dismissed offer stays dismissed. */
  key: string
  spec: PatternSpec
  /** The distinct values it was learned from, in the order they were redacted. */
  examples: string[]
  /** The category most of them were redacted as. */
  category: string
  /** A readable stand-in for the shape, such as `EMP-00xxx`. */
  display: string
}

/**
 * The pattern a set of alike values share, or null when it would be anchored
 * to nothing. Every example is checked against the result: a pattern that
 * does not match what it was learned from is not offered.
 */
export function learnPattern(values: string[]): {
  spec: PatternSpec
  display: string
} | null {
  const distinct = [...new Set(values.map((value) => value.trim()))].filter(
    Boolean
  )
  if (distinct.length < 2) return null

  const tokenized = distinct.map(tokenize)
  const width = tokenized[0].length
  if (tokenized.some((tokens) => tokens.length !== width)) return null

  let pattern = ""
  let display = ""
  let anchoredLiteral = 0
  let hasDigits = false
  let minimumLength = 0

  for (let position = 0; position < width; position += 1) {
    const column = tokenized.map((tokens) => tokens[position])
    const { cls } = column[0]
    const texts = column.map((token) => token.text)
    const same = texts.every((text) => text === texts[0])
    minimumLength += Math.min(...texts.map((text) => [...text].length))

    if (cls === "symbol") {
      pattern += escapeRegex(texts[0])
      display += texts[0]
    } else if (cls === "space") {
      pattern += "\\s+"
      display += " "
    } else if (cls === "digits") {
      hasDigits = true
      // A run of digits that never varies is part of the name, not the
      // number: keep it, as `00` is kept in `EMP-00xxx`.
      if (same) {
        pattern += texts[0]
        display += texts[0]
        anchoredLiteral += texts[0].length
      } else {
        const prefix = commonPrefix(texts)
        pattern +=
          escapeRegex(prefix) +
          "\\d" +
          lengths(texts.map((text) => text.slice(prefix.length)))
        display +=
          prefix +
          "x".repeat(
            Math.max(
              1,
              Math.min(...texts.map((text) => text.length)) - prefix.length
            )
          )
        anchoredLiteral += prefix.length
      }
    } else if (same) {
      pattern += escapeRegex(texts[0])
      display += texts[0]
      anchoredLiteral += [...texts[0]].length
    } else {
      pattern += letterClass(texts) + lengths(texts)
      display += "…"
    }
  }

  // Anchored: literal text every example shares, or a number long enough to
  // be an identifier rather than a quantity.
  const anchored = anchoredLiteral >= 2 || (hasDigits && minimumLength >= 6)
  if (!anchored) return null

  const spec: PatternSpec = {
    kind: "regex",
    pattern,
    // Learned from how the values were written, so written that way.
    matchCase: true,
    wholeWord: true,
  }

  try {
    const compiled = compilePattern(spec)
    const matchesAll = distinct.every((value) => {
      const [hit] = compiled.find(value)
      return hit !== undefined && hit.start === 0 && hit.end === value.length
    })
    if (!matchesAll) return null
  } catch {
    return null
  }

  return { spec, display }
}

function commonPrefix(texts: string[]): string {
  let prefix = texts[0]
  for (const text of texts.slice(1)) {
    while (!text.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  // Never the whole run: at least one digit has to vary, or it would be `same`.
  return prefix
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other"
}

/**
 * The shapes worth offering a rule for, from the reviewer's own redactions.
 *
 * Only redactions they made by hand count: a shape the detectors already find
 * does not need a rule, and a rule's own redactions would teach it itself.
 * `known` holds the patterns of rules that already exist, so an offer is never
 * made for a rule the reviewer already has.
 */
export function learnShapes(
  redactions: {
    text?: string
    source: string
    status: string
    category: string
    type: string
  }[],
  options: { threshold?: number; known?: string[] } = {}
): LearnedShape[] {
  const threshold = options.threshold ?? LEARN_THRESHOLD
  const known = new Set(options.known ?? [])

  const bySignature = new Map<
    string,
    { values: string[]; categories: string[] }
  >()
  for (const redaction of redactions) {
    if (redaction.source !== "user" || redaction.type !== "text") continue
    if (redaction.status === "rejected") continue
    const text = redaction.text?.trim()
    if (!text || text.length < 3 || text.length > 80) continue

    const key = signature(text)
    const group = bySignature.get(key) ?? { values: [], categories: [] }
    if (!group.values.includes(text)) {
      group.values.push(text)
      group.categories.push(redaction.category)
    }
    bySignature.set(key, group)
  }

  const shapes: LearnedShape[] = []
  for (const group of bySignature.values()) {
    if (group.values.length < threshold) continue
    const learned = learnPattern(group.values)
    if (!learned || known.has(learned.spec.pattern)) continue
    shapes.push({
      key: learned.spec.pattern,
      spec: learned.spec,
      examples: group.values,
      category: mostCommon(group.categories),
      display: learned.display,
    })
  }

  return shapes
}
