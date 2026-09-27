/**
 * How Hush points at a place in a document.
 *
 * The agent never writes offsets of its own: it gets a reference from a tool
 * that found something, and hands the same reference back to the tool that
 * acts on it. The acting tool re-reads the document at that reference and
 * refuses when the text there is not the text the reviewer approved. So what
 * the approval card showed is exactly what gets redacted, however the model
 * copied it.
 *
 *   p{page}:{start}-{end}      characters on a page, end exclusive
 *   c{sheet}:{row}:{column}    a spreadsheet cell, by sheet position
 *
 * Isomorphic: the panel reads references to jump to them.
 */

export type Reference =
  | { kind: "text"; page: number; start: number; end: number }
  | { kind: "cell"; sheet: number; row: number; column: number }

export function textReference(
  page: number,
  start: number,
  end: number
): string {
  return `p${page}:${start}-${end}`
}

export function cellReference(
  sheet: number,
  row: number,
  column: number
): string {
  return `c${sheet}:${row}:${column}`
}

const TEXT = /^p(\d{1,7}):(\d{1,9})-(\d{1,9})$/
const CELL = /^c(\d{1,4}):(\d{1,7}):(\d{1,5})$/

export function parseReference(value: string): Reference | null {
  const text = TEXT.exec(value)
  if (text) {
    const [page, start, end] = text.slice(1).map(Number)
    if (page < 1 || end <= start) return null
    return { kind: "text", page, start, end }
  }
  const cell = CELL.exec(value)
  if (cell) {
    const [sheet, row, column] = cell.slice(1).map(Number)
    if (row < 1 || column < 1) return null
    return { kind: "cell", sheet, row, column }
  }
  return null
}
