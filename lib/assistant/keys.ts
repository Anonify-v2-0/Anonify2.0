import { normalizeValue } from "@/lib/documents/shared/text"
import type { Redaction } from "@/types/redaction"

/**
 * The key a suggestion group goes by: category and folded value, exactly as
 * the inspector groups them (`selectOccurrenceGroups`). Hush names groups by
 * it, and the approval card resolves the same key against the redactions in
 * the store, so the reviewer sees the values a bulk accept or reject touches.
 */
export function suggestionKeyOf(
  redaction: Pick<Redaction, "category" | "text">
): string {
  return `${redaction.category}|${normalizeValue(redaction.text ?? redaction.category)}`
}
