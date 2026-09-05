import {
  decodeText,
  encodeText,
  parseDelimited,
  serializeDelimited,
} from "@/lib/documents/delimited/parse"
import { delimiterFor } from "@/lib/documents/delimited/extract"
import { cutRanges, valueMatcher } from "@/lib/documents/shared/text"
import type { DocumentKind } from "@/types/document"

/**
 * CSV and TSV redaction.
 *
 * The file is re-parsed into the same grid extraction produced, the addressed
 * cells are rewritten, and the grid is serialized back. Nothing here does a
 * string replacement over the file: a value that happens to appear inside
 * another field, or a header that shares a name with a value, would be edited
 * by accident, and a replacement containing a delimiter or a quote would
 * silently change the shape of every row after it.
 *
 * The parse is the mapping. Because it is deterministic, a row/column address
 * captured at extraction still names the same field now.
 */

export type DelimitedRedactionPlan = {
  /** Cells addressed by 1-based row and column. */
  cells: { row: number; column: number }[]
  /** Whole rows, every field. */
  rows: number[]
  /** Whole columns below the header, which keeps the sheet readable. */
  columns: number[]
  /** Accepted values, removed wherever else they appear in a field. */
  values: string[]
  /** Visible marker left behind, or null to close the gap silently. */
  label: string | null
}

const HEADER_ROW = 1

export function redactDelimited(
  kind: DocumentKind,
  bytes: Uint8Array,
  plan: DelimitedRedactionPlan
): Uint8Array {
  const { text, bom } = decodeText(bytes)
  const parsed = parseDelimited(text, delimiterFor(kind), { bom })

  const blank = (row: number, column: number) => {
    const fields = parsed.rows[row - 1]
    if (!fields) return
    const field = fields[column - 1]
    if (!field || field.value.length === 0) return
    field.value = plan.label ?? ""
  }

  for (const column of plan.columns) {
    for (let row = HEADER_ROW + 1; row <= parsed.rows.length; row++) {
      blank(row, column)
    }
  }

  for (const row of plan.rows) {
    const fields = parsed.rows[row - 1]
    if (!fields) continue
    for (let column = 1; column <= fields.length; column++) blank(row, column)
  }

  for (const cell of plan.cells) blank(cell.row, cell.column)

  // The safety net, applied field by field rather than to the file: the same
  // value can sit in a cell nobody reviewed, and a partial match inside a
  // longer field still has to go.
  //
  // Compiled once and run over each field, rather than looping the values
  // inside the loop over fields. A grid where every row holds a different
  // address is the case that makes the difference between the two: twenty
  // thousand values against eighty thousand fields is a product nobody wants
  // to wait for.
  const matcher = valueMatcher(plan.values)

  if (matcher.size > 0) {
    for (const fields of parsed.rows) {
      for (const field of fields) {
        if (field.value.length === 0) continue
        const ranges = matcher.find(field.value)
        if (ranges.length === 0) continue
        field.value = cutRanges(field.value, ranges, () => plan.label ?? "")
      }
    }
  }

  return encodeText(serializeDelimited(parsed))
}
