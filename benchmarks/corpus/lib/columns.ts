/**
 * The columns of a tabular export, read from its text with each cell's
 * offset, so a check can ask whether a cell is labelled (#202).
 *
 * A model writing a support-ticket export labels the names, addresses and
 * phone numbers in each row and can still leave a `customer_ref` column bare.
 * Every value in that column is a customer id, and a detector that redacts
 * one is then scored as wrong at every row. The check that a value labelled
 * once is labelled everywhere cannot see a value that is never labelled.
 *
 * This is not the app's CSV parser (lib/documents/delimited): that one
 * rebuilds a file and needs no offsets, and it reads only commas and tabs,
 * where a generated export also uses semicolons and pipes.
 */

export type Cell = { value: string; start: number; end: number }

export type Column = { header: string; cells: Cell[] }

const DELIMITERS = [",", ";", "\t", "|"] as const

/** One row per line, each cell with its offset; quotes may hold delimiters and line breaks. */
function rows(text: string, delimiter: string): Cell[][] {
  const result: Cell[][] = []
  let row: Cell[] = []
  let i = 0
  for (;;) {
    // Whitespace before an opening quote: `a, "b, c"`.
    let j = i
    while (text[j] === " ") j++
    if (text[j] === '"') {
      const start = j + 1
      let k = start
      while (k < text.length && !(text[k] === '"' && text[k + 1] !== '"'))
        k += text[k] === '"' ? 2 : 1
      row.push({ value: text.slice(start, k), start, end: k })
      i = k + 1
      while (i < text.length && text[i] !== delimiter && text[i] !== "\n") i++
    } else {
      let k = i
      while (k < text.length && text[k] !== delimiter && text[k] !== "\n") k++
      const raw = text.slice(i, k)
      const lead = raw.length - raw.trimStart().length
      const value = raw.trim()
      row.push({ value, start: i + lead, end: i + lead + value.length })
      i = k
    }
    if (i >= text.length || text[i] === "\n") {
      result.push(row)
      row = []
      if (i >= text.length) return result
    }
    i++
  }
}

/**
 * Every column under a header row: a row of at least three cells followed by
 * rows of the same width. Each delimiter is tried, and only the one a table
 * is really written in gives rows of a steady width.
 */
export function tableColumns(text: string): Column[] {
  const columns: Column[] = []
  for (const delimiter of DELIMITERS) {
    const all = rows(text, delimiter)
    for (let r = 0; r < all.length; r++) {
      const header = all[r]
      if (header.length < 3) continue
      let end = r + 1
      while (end < all.length && all[end].length === header.length) end++
      if (end === r + 1) continue
      for (const [index, cell] of header.entries()) {
        columns.push({
          header: cell.value,
          cells: all.slice(r + 1, end).map((row) => row[index]),
        })
      }
      r = end - 1
    }
  }
  return columns
}

const PERSON = String.raw`customer|client|member|patient|employee|staff|policy\s*holder|account\s*holder|subscriber|tenant|kunden?|mitglieds?|patienten|personal|versicherten|adh[ée]rent|membre|salari[ée]|cliente|socio|paciente|empleado|asegurado`
const REFERENCE = String.raw`(?<!\p{L})(?:ref|reference|referenz|referencia|r[ée]f[ée]rence|id|no|num|number|n[°º]|n[uú]mero|num[ée]ro|code|#)(?!\p{L})|(?:nummer|nr)(?!\p{L})`

/**
 * A header that names a reference tied to a person: customer_ref, client_id,
 * Mitgliedsnummer, N° adhérent. Not account numbers, which are bank accounts.
 */
export function isPersonReferenceHeader(header: string): boolean {
  if (header.length > 40) return false
  return (
    new RegExp(`(?:${PERSON})`, "iu").test(header) &&
    new RegExp(REFERENCE, "iu").test(header)
  )
}

/** A cell with something in it: not blank, and not a dash or "n/a" standing for blank. */
function filled(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value) && !/^(?:n\/?a|none|null)$/i.test(value)
}

type Range = { start: number; end: number }

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end

/**
 * The filled cells of a person-reference column that are neither labelled
 * nor declared a hard negative. A decoy in such a column, a row id that is
 * nobody's, is fine once it is declared one.
 */
export function unlabelledReferenceCells(
  text: string,
  spans: Range[],
  negatives: Range[]
): Array<Cell & { header: string }> {
  return tableColumns(text)
    .filter((column) => isPersonReferenceHeader(column.header))
    .flatMap((column) =>
      column.cells
        .filter((cell) => filled(cell.value))
        .filter(
          (cell) =>
            !spans.some((span) => overlaps(span, cell)) &&
            !negatives.some((negative) => overlaps(negative, cell))
        )
        .map((cell) => ({ ...cell, header: column.header }))
    )
}
