import { normalizeValue } from "@/lib/documents/shared/text"
import { findOccurrences } from "@/lib/documents/ooxml/xml-text"
import type { NormalizedDocument } from "@/types/document"
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
  options: { category: string; confidence?: number; reason?: string }
): Detection[] {
  const found: Detection[] = []
  if (!value.trim()) return found

  for (const page of model.pages) {
    for (const range of findOccurrences(page.text, value)) {
      found.push({
        text: page.text.slice(range.start, range.end),
        category: options.category,
        confidence: options.confidence ?? 0.9,
        reason: options.reason,
        page: page.number,
        start: range.start,
        end: range.end,
        global: true,
      })
    }
  }

  for (const sheet of model.sheets ?? []) {
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

/** Collapses detections that cover the same location. */
export function dedupeDetections(detections: Detection[]): Detection[] {
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
