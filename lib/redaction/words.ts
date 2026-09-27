import type { CharRange } from "@/lib/documents/shared/text"
import { detectPatterns } from "@/lib/redaction/detectors"

/**
 * The value under a click.
 *
 * A span in the normalized model is whatever the extractor produced: a word
 * from OCR, a run of a PDF line, a whole line of a text file. Clicking used to
 * redact the span, so a click on an employee number in a text file redacted
 * the line it was on. A reviewer clicking a value means the value, so the
 * click is widened from the character under it to the token around it — and a
 * token here is what sensitive values look like: letters and digits joined by
 * the punctuation identifiers, emails and phone numbers use (`EMP-10007`,
 * `jane.doe1@example.com`, `O'Brien`), without the sentence punctuation
 * around them (`Doe)`, `90001.`).
 *
 * Some values are written with spaces in them, and one token of those leaves
 * the rest readable: a click on `4111 1111 1111 1111` would take one `1111`.
 * So the token is widened again, never narrowed, to cover
 *
 *   - whatever the deterministic detectors find around it — a card number,
 *     `+44 20 7946 0958`, `(555) 123-4567`, an address, a labelled date; and
 *   - the run of short groups it sits in, joined by single spaces, for the
 *     shapes the detectors do not take whole: `GB82 WEST 1234 5698 7654 32`,
 *     `555 0100`.
 *
 * A name stays one word. `Jane` is a click on Jane; `Jane Doe` is a drag, and
 * guessing where a name ends would redact the words beside it.
 */

const TOKEN = /[\p{L}\p{N}\p{M}_@+\-'.]/u
const EDGE = /[@+\-'.]/u

/**
 * A group in a value written in groups: up to four capitals or digits (`GB82`,
 * `WEST`, `1234`), or digits of any length, with the joiners a phone number
 * uses (`0100`, `123-4567`).
 */
const GROUP = /^(?:[A-Z0-9]{1,4}|[\d.-]*\d[\d.-]*)$/
/**
 * The longest run of groups taken as one value: a spaced IBAN, the longest
 * such value, is 42 characters. Longer is a row of figures, not a value.
 */
const MAX_RUN = 42
/** How much text around the click the detectors read. */
const WINDOW = 256

/**
 * The value under `offset`: the token containing it, widened to a detected
 * value or a run of groups it belongs to. Null where there is no token (a
 * space).
 */
export function wordAt(text: string, offset: number): CharRange | null {
  if (offset < 0 || offset > text.length) return null
  // A click on the right half of the last character lands after it.
  let at = offset
  if (at === text.length || !TOKEN.test(text[at])) {
    if (at > 0 && TOKEN.test(text[at - 1])) at -= 1
    else return null
  }

  const token = tokenAt(text, at)
  if (!token) return null
  let { start, end } = token

  const run = groupRunAround(text, token)
  if (run) {
    start = Math.min(start, run.start)
    end = Math.max(end, run.end)
  }

  // Detected values are read in a window around the click: a click is not
  // worth a sweep of a page that can be a whole text file.
  const from = Math.max(0, at - WINDOW)
  const detected = detectPatterns(text.slice(from, at + WINDOW), {
    offset: from,
  }).find(
    (detection) =>
      detection.start !== undefined &&
      detection.end !== undefined &&
      detection.start <= at &&
      at < detection.end
  )
  if (detected?.start !== undefined && detected.end !== undefined) {
    start = Math.min(start, detected.start)
    end = Math.max(end, detected.end)
  }

  return { start, end }
}

/** The token around the token character at `at`, joiners trimmed off. */
function tokenAt(text: string, at: number): CharRange | null {
  let start = at
  let end = at + 1
  while (start > 0 && TOKEN.test(text[start - 1])) start -= 1
  while (end < text.length && TOKEN.test(text[end])) end += 1

  // Joiners belong inside a token, never at its edges.
  while (start < end && EDGE.test(text[start])) start += 1
  while (end > start && EDGE.test(text[end - 1])) end -= 1

  return end > start ? { start, end } : null
}

/**
 * The run of groups `token` belongs to, joined by single spaces, with plain
 * words at either end left out (`IBAN` in `IBAN GB82 WEST …`). Null when the
 * token is not a group, stands alone, or is only a word beside the run.
 */
function groupRunAround(text: string, token: CharRange): CharRange | null {
  const isGroup = (range: CharRange) =>
    GROUP.test(text.slice(range.start, range.end))
  if (!isGroup(token)) return null

  const groups = [token]
  for (;;) {
    const first = groups[0]
    if (text[first.start - 1] !== " " || first.start < 2) break
    const previous = TOKEN.test(text[first.start - 2])
      ? tokenAt(text, first.start - 2)
      : null
    if (!previous || previous.end !== first.start - 1 || !isGroup(previous))
      break
    groups.unshift(previous)
  }
  for (;;) {
    const last = groups[groups.length - 1]
    if (text[last.end] !== " " || !TOKEN.test(text[last.end + 1] ?? "")) break
    const next = tokenAt(text, last.end + 1)
    if (!next || next.start !== last.end + 1 || !isGroup(next)) break
    groups.push(next)
  }

  const hasDigit = (range: CharRange) =>
    /\d/.test(text.slice(range.start, range.end))
  while (groups.length > 0 && !hasDigit(groups[0])) groups.shift()
  while (groups.length > 0 && !hasDigit(groups[groups.length - 1])) groups.pop()
  if (groups.length < 2) return null

  const run = { start: groups[0].start, end: groups[groups.length - 1].end }
  if (run.end - run.start > MAX_RUN) return null
  // A word clicked beside the run is still just the word.
  if (token.start < run.start || token.end > run.end) return null
  return run
}

/**
 * The character a horizontal position falls on, inside a PDF span whose
 * characters were measured (`TextSpan.offsets`: where each one starts, plus
 * where the last one ends). Returns an offset into the span's text.
 */
export function characterAtX(offsets: number[], x: number): number {
  if (offsets.length < 2) return 0
  for (let index = 0; index < offsets.length - 1; index += 1) {
    if (x < offsets[index + 1]) return index
  }
  return offsets.length - 2
}
