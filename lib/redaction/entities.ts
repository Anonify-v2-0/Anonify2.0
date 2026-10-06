import { normalizeValue } from "@/lib/documents/shared/text"
import { findOccurrences } from "@/lib/documents/ooxml/xml-text"
import type {
  NormalizedDocument,
  NormalizedPage,
  SpreadsheetSheet,
} from "@/types/document"
import type { Detection } from "@/types/redaction"

/**
 * Entity handling.
 *
 * A value that has been judged sensitive once does not need to be judged again.
 * Occurrences two through seventeen are found by searching the normalized text
 * locally, which costs nothing and — unlike asking again — cannot come back with
 * a different answer for the same string.
 */

export type Entity = {
  normalizedValue: string
  /** The form the detector or model actually reported. */
  value: string
  category: string
  confidence: number
  global: boolean
  reason?: string
  occurrences: number
}

export function buildEntities(detections: Detection[]): Entity[] {
  const byValue = new Map<string, Entity>()

  for (const detection of detections) {
    const normalized = normalizeValue(detection.text)
    if (!normalized) continue

    const existing = byValue.get(normalized)
    if (!existing) {
      byValue.set(normalized, {
        normalizedValue: normalized,
        value: detection.text,
        category: detection.category,
        confidence: detection.confidence,
        global: detection.global ?? false,
        reason: detection.reason,
        occurrences: 1,
      })
      continue
    }

    existing.occurrences += 1
    // Keep the most confident reading of a value that was detected twice.
    if (detection.confidence > existing.confidence) {
      existing.confidence = detection.confidence
      existing.category = detection.category
      existing.reason = detection.reason
    }
    existing.global = existing.global || (detection.global ?? false)
  }

  return [...byValue.values()]
}

/**
 * Finds every occurrence of a value across the document, locally. This is what
 * makes "redact all 17" cost nothing, and it is also how a user-created global
 * rule is applied without another model call.
 */
export function findAllOccurrences(
  model: NormalizedDocument,
  value: string,
  options: OccurrenceOptions
): Detection[] {
  if (!value.trim()) return []
  return [
    ...model.pages.flatMap((page) => occurrencesInPage(page, value, options)),
    ...occurrencesInSheets(model.sheets ?? [], value, options),
  ]
}

export type OccurrenceOptions = {
  category: string
  confidence?: number
  reason?: string
  /**
   * Only occurrences that stand as a value of their own (see `standsAlone`).
   * The local search after analysis asks for this, so `raman` is not found
   * inside `priya.raman@example.org` (#205). A reviewer's rule to redact a
   * value everywhere does not, and still matches inside anything.
   */
  standalone?: boolean
}

const ALNUM = /[\p{L}\p{N}]/u
const DIGIT = /\p{N}/u
const JOINER = /[.@_+-]/

/**
 * Whether the characters at `start`–`end` stand on their own rather than
 * continue a token. They do not when a letter or digit comes right before
 * them, a digit right after, or a `.`, `@`, `_`, `+` or `-` that joins them
 * to more letters or digits on either side: inside an email address, a
 * handle, a longer reference. A letter right after is allowed, so a name
 * with an ending is still found: German `Maras`, without an apostrophe.
 */
export function standsAlone(text: string, start: number, end: number): boolean {
  const before = text[start - 1]
  if (before && ALNUM.test(before)) return false
  if (before && JOINER.test(before) && ALNUM.test(text[start - 2] ?? ""))
    return false
  const after = text[end]
  if (after && DIGIT.test(after)) return false
  if (after && JOINER.test(after) && ALNUM.test(text[end + 1] ?? ""))
    return false
  return true
}

/**
 * The occurrences on one page. `findAllOccurrences` is this over every page
 * and then the sheets, which is what lets a caller holding one page at a time
 * reach exactly the same answer.
 */
export function occurrencesInPage(
  page: NormalizedPage,
  value: string,
  options: OccurrenceOptions
): Detection[] {
  if (!value.trim()) return []
  const ranges = findOccurrences(page.text, value)
  return (
    options.standalone
      ? ranges.filter((range) => standsAlone(page.text, range.start, range.end))
      : ranges
  ).map((range) => ({
    text: page.text.slice(range.start, range.end),
    category: options.category,
    confidence: options.confidence ?? 0.9,
    reason: options.reason,
    page: page.number,
    start: range.start,
    end: range.end,
    global: true,
  }))
}

export function occurrencesInSheets(
  sheets: SpreadsheetSheet[],
  value: string,
  options: OccurrenceOptions
): Detection[] {
  const found: Detection[] = []
  if (!value.trim()) return found

  for (const sheet of sheets) {
    for (const cell of sheet.cells) {
      if (!cell.value) continue
      if (!cell.value.toLowerCase().includes(value.toLowerCase())) continue
      found.push({
        text: value,
        category: options.category,
        confidence: options.confidence ?? 0.9,
        reason: options.reason,
        worksheet: sheet.name,
        row: cell.row,
        column: cell.column,
        global: true,
      })
    }
  }

  return found
}

/**
 * Collapses detections that cover the same location, and folds one that lies
 * inside another of the same category on the same page into it: `Raman`
 * inside `Priya Raman` is one suggestion for a reviewer, not two (#205).
 */
export function dedupeDetections(detections: Detection[]): Detection[] {
  return foldContained(collapseDuplicates(detections))
}

function collapseDuplicates(detections: Detection[]): Detection[] {
  const seen = new Map<string, Detection>()

  for (const detection of detections) {
    const key = [
      detection.page ?? "",
      detection.worksheet ?? "",
      detection.row ?? "",
      detection.column ?? "",
      detection.start ?? "",
      detection.end ?? "",
      normalizeValue(detection.text),
    ].join("|")

    const existing = seen.get(key)
    if (!existing || detection.confidence > existing.confidence) {
      seen.set(key, detection)
    }
  }

  return [...seen.values()]
}

/**
 * Drops each text detection that lies inside a longer one of the same
 * category on the same page. Cell detections, which have no offsets, pass
 * through. Order is kept.
 */
function foldContained(detections: Detection[]): Detection[] {
  const groups = new Map<string, number[]>()
  detections.forEach((detection, index) => {
    if (detection.start === undefined || detection.end === undefined) return
    if (detection.worksheet !== undefined) return
    const key = `${detection.page ?? 1}\u0000${detection.category}`
    groups.set(key, [...(groups.get(key) ?? []), index])
  })
  const folded = new Set<number>()
  for (const indexes of groups.values()) {
    // By start, longest first: one that ends within the furthest reach so far
    // starts and ends inside a detection already kept.
    const ordered = [...indexes].sort(
      (a, b) =>
        detections[a].start! - detections[b].start! ||
        detections[b].end! - detections[a].end!
    )
    let reach = -Infinity
    for (const index of ordered) {
      if (detections[index].end! <= reach) folded.add(index)
      else reach = detections[index].end!
    }
  }
  return detections.filter((_, index) => !folded.has(index))
}

/** What may separate two parts of one value: a comma, and a space or line break. */
const SEAM = /^[ \t]*,?[ \t]*\n?[ \t]*$/

/**
 * Joins a value the patterns found to the part of it the model found beside
 * it (#207). The address pattern matches a street line, `42 Larch Court`;
 * told that was already found, the model reports the rest, `Flat 3,
 * Stowmarket, IP14 2RN`, as a value of its own. Two suggestions for one
 * address leave the comma between them, and score as a street and a town
 * rather than an address.
 *
 * So a text detection of a value the patterns found, and one beside it of a
 * value the model found, in the same category on the same page, with nothing
 * between but a comma and a space or a line break, become one suggestion
 * over both. Values, not positions: the local search's copy of the town
 * beside a street line is as much the model's as the one it reported. A
 * joined value can join again, so a flat, a street and a town in three
 * pieces are one. Two values the model found side by side, two names in a
 * list, stay two: each was a decision of its own.
 *
 * It runs after the local search, which looks for each part as it was
 * found: a street line elsewhere on its own is still found.
 */
export function joinAdjacent(
  detections: Detection[],
  sources: { patterns: Detection[]; model: Detection[] },
  pages: Map<number, string>
): Detection[] {
  const value = (d: Detection) => `${d.category}\u0000${normalizeValue(d.text)}`
  const fromPatterns = new Set(sources.patterns.map(value))
  const fromModel = new Set(sources.model.map(value))
  const origin = new Map<Detection, Set<"patterns" | "model">>()
  for (const d of detections) {
    const found = new Set<"patterns" | "model">()
    if (fromPatterns.has(value(d))) found.add("patterns")
    if (fromModel.has(value(d))) found.add("model")
    origin.set(d, found)
  }

  const onText = (d: Detection) =>
    d.start !== undefined && d.end !== undefined && d.worksheet === undefined
  const text = detections.filter(onText)
  const other = detections.filter((d) => !onText(d))
  const ordered = [...text].sort(
    (a, b) => (a.page ?? 1) - (b.page ?? 1) || a.start! - b.start!
  )

  const joined: Detection[] = []
  for (const detection of ordered) {
    // Only the one just before: nothing else may lie between them.
    const previous = joined[joined.length - 1] as Detection | undefined
    const page = pages.get(detection.page ?? 1)
    const left = previous && origin.get(previous)!
    const right = origin.get(detection)!
    const complementary =
      left &&
      ((left.has("patterns") && right.has("model")) ||
        (left.has("model") && right.has("patterns")))
    if (
      previous &&
      page !== undefined &&
      complementary &&
      (previous.page ?? 1) === (detection.page ?? 1) &&
      previous.category === detection.category &&
      previous.end! <= detection.start! &&
      SEAM.test(page.slice(previous.end!, detection.start!))
    ) {
      const merged: Detection = {
        ...previous,
        text: page.slice(previous.start!, detection.end!),
        end: detection.end,
        confidence: Math.max(previous.confidence, detection.confidence),
        reason: right.has("model") ? detection.reason : previous.reason,
      }
      origin.set(merged, new Set([...left!, ...right]))
      joined[joined.length - 1] = merged
      continue
    }
    joined.push(detection)
  }

  return [...joined, ...other]
}

/**
 * Locates a model-reported value in the normalized text. The model returns the
 * text it saw, not an offset, so the application finds the position itself —
 * a detection that cannot be located is dropped rather than guessed at.
 */
export function locateInPage(
  pageText: string,
  value: string,
  searchFrom = 0
): { start: number; end: number } | null {
  const exact = pageText.indexOf(value, searchFrom)
  if (exact !== -1) return { start: exact, end: exact + value.length }

  // Whitespace in extracted text is unreliable; allow it to differ.
  const pattern = new RegExp(
    value
      .trim()
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
    "i"
  )

  const match = pattern.exec(pageText.slice(searchFrom))
  if (!match) return null

  return {
    start: searchFrom + match.index,
    end: searchFrom + match.index + match[0].length,
  }
}
