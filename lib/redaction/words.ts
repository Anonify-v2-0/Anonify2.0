import type { CharRange } from "@/lib/documents/shared/text"

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
 */

const TOKEN = /[\p{L}\p{N}\p{M}_@+\-'.]/u
const EDGE = /[@+\-'.]/u

/** The token containing `offset`, or null where there is none (a space). */
export function wordAt(text: string, offset: number): CharRange | null {
  if (offset < 0 || offset > text.length) return null
  // A click on the right half of the last character lands after it.
  let at = offset
  if (at === text.length || !TOKEN.test(text[at])) {
    if (at > 0 && TOKEN.test(text[at - 1])) at -= 1
    else return null
  }

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
