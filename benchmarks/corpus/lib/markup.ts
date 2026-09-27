import {
  fillPlaceholder,
  nameParts,
  PLACEHOLDER,
  PLACEHOLDER_CATEGORY,
  PlaceholderError,
  type FillContext,
} from "./fill"
import { isCategory, type Span } from "./types"

/**
 * The markup stripper.
 *
 * The model writes `[[category|value]]` around every piece of personal data as
 * it writes it. This turns that into plain text plus exact offsets. A label is
 * correct because the value was put there, not because anyone read it back.
 *
 * Offsets are JavaScript string indices (UTF-16 code units) into the stripped
 * text: `text.slice(start, end) === value` for every span.
 */

export type StripResult = {
  text: string
  spans: Span[]
  /** Everything malformed, in order. Any entry rejects the document. */
  errors: string[]
}

const OPEN = "[["
const CLOSE = "]]"

function excerpt(body: string, at: number): string {
  return JSON.stringify(body.slice(Math.max(0, at - 20), at + 40))
}

const PLACEHOLDER_ONLY_VALUE =
  /(\[\[[a-z-]+\|\{\{[A-Z_]+(?::[A-Za-z0-9_-]+)?\}\})(?:\}\]|\}\}|\](?!\]))/g
const MARKUP = /\[\[[\s\S]*?\]\]/g

/**
 * Repairs the two slips models make that have exactly one reading, and
 * nothing else:
 *
 * - a closing brace for a bracket after a placeholder: `[[email|{{EMAIL}}}]`
 *   or `[[email|{{EMAIL}}}}` for `[[email|{{EMAIL}}]]`;
 * - a placeholder with no markup around it: `{{PHONE}}` for
 *   `[[phone|{{PHONE}}]]`. The placeholder names its category, and the value
 *   is the script's own, so the label is still correct by construction.
 *
 * Everything else that is malformed is left for `stripMarkup` to reject. The
 * count is recorded on the document.
 */
export function repairMarkup(body: string): { body: string; repairs: number } {
  let repairs = 0
  const closed = body.replace(
    PLACEHOLDER_ONLY_VALUE,
    (_match, head: string) => {
      repairs++
      return `${head}]]`
    }
  )

  let out = ""
  let at = 0
  const wrapBare = (segment: string) =>
    segment.replace(PLACEHOLDER, (match, name: string) => {
      const category = PLACEHOLDER_CATEGORY[name]
      if (!category) return match
      repairs++
      return `[[${category}|${match}]]`
    })
  for (const markup of closed.matchAll(MARKUP)) {
    out += wrapBare(closed.slice(at, markup.index)) + markup[0]
    at = markup.index + markup[0].length
  }
  out += wrapBare(closed.slice(at))
  return { body: out, repairs }
}

export function stripMarkup(body: string, context: FillContext): StripResult {
  let text = ""
  const spans: Span[] = []
  const errors: string[] = []

  const appendPlain = (segment: string, at: number) => {
    const stray = segment.indexOf(CLOSE)
    if (stray !== -1)
      errors.push(`"]]" with no opening "[[" near ${excerpt(body, at + stray)}`)
    const placeholder = segment.search(/\{\{|\}\}/)
    if (placeholder !== -1) {
      errors.push(
        `placeholder outside markup near ${excerpt(body, at + placeholder)}`
      )
    }
    text += segment
  }

  let at = 0
  while (at < body.length) {
    const open = body.indexOf(OPEN, at)
    if (open === -1) {
      appendPlain(body.slice(at), at)
      break
    }
    appendPlain(body.slice(at, open), at)

    const close = body.indexOf(CLOSE, open + OPEN.length)
    if (close === -1) {
      errors.push(`"[[" is never closed near ${excerpt(body, open)}`)
      text += body.slice(open)
      break
    }
    const inner = body.slice(open + OPEN.length, close)
    at = close + CLOSE.length

    if (inner.includes(OPEN)) {
      errors.push(`nested markup near ${excerpt(body, open)}`)
      continue
    }
    const bar = inner.indexOf("|")
    if (bar === -1) {
      errors.push(`markup without a category near ${excerpt(body, open)}`)
      continue
    }
    const category = inner.slice(0, bar).trim()
    if (!isCategory(category)) {
      errors.push(`unknown category "${category}" near ${excerpt(body, open)}`)
      continue
    }

    let placeholder: string | undefined
    let entity: string | undefined
    let value: string
    try {
      value = inner
        .slice(bar + 1)
        .replace(PLACEHOLDER, (_match, name: string, key?: string) => {
          const expected = PLACEHOLDER_CATEGORY[name]
          if (expected && expected !== category) {
            throw new PlaceholderError(
              `{{${name}}} marked up as "${category}", expected "${expected}"`
            )
          }
          placeholder = name
          if (key && context.cast.has(key)) entity = key
          return fillPlaceholder(name, key, context)
        })
    } catch (error) {
      if (!(error instanceof PlaceholderError)) throw error
      errors.push(`${error.message} near ${excerpt(body, open)}`)
      continue
    }
    if (/\{\{|\}\}/.test(value)) {
      errors.push(`malformed placeholder near ${excerpt(body, open)}`)
      continue
    }

    // Whitespace the model left inside the brackets belongs to the text, not
    // to the label, or a detector that finds the exact value looks partial.
    const leading = value.length - value.trimStart().length
    const trimmed = value.trim()
    if (!trimmed) {
      errors.push(`empty value near ${excerpt(body, open)}`)
      text += value
      continue
    }
    text += value.slice(0, leading)
    const start = text.length
    text += trimmed
    text += value.slice(leading + trimmed.length)
    spans.push({
      start,
      end: start + trimmed.length,
      category,
      value: trimmed,
      ...(entity ? { entity } : {}),
      ...(placeholder ? { placeholder } : {}),
    })
  }

  return { text, spans, errors }
}

/**
 * Which cast member a `person` span refers to, when it can be told: every
 * name-like token in the value has to belong to exactly one cast member's
 * name, either whole or as an initial. "Dr. Priya Raman", "Priya", "P. Raman"
 * and "Raman's" all resolve to the cast member called Priya Raman.
 */
export function inferEntity(
  value: string,
  cast: Map<string, string>
): string | undefined {
  const tokens = nameParts(value.replace(/['’]s$/, "").replace(/\./g, ". "))
  if (tokens.length === 0) return undefined
  const matches: string[] = []
  for (const [id, name] of cast) {
    const parts = nameParts(name)
    const fits = tokens.every((token) =>
      token.length === 1
        ? parts.some((part) => part.startsWith(token))
        : parts.includes(token)
    )
    if (fits && tokens.some((token) => token.length > 1 || tokens.length > 1))
      matches.push(id)
  }
  return matches.length === 1 ? matches[0] : undefined
}
