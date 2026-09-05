import {
  decodeText,
  parseDelimited,
  type DelimitedDocument,
  type Delimiter,
} from "@/lib/documents/delimited/parse"
import type {
  DocumentKind,
  NormalizedDocument,
  SpreadsheetCell,
  SpreadsheetSheet,
} from "@/types/document"

/**
 * CSV and TSV extraction.
 *
 * A delimited file is a grid, so it normalizes to the same worksheet model a
 * workbook does. That is not a convenience: it means the detectors, the
 * column-level analysis, the review grid and the cell/row/column redaction
 * units all work on a CSV without a line of new code, and a redaction carries
 * the address it will be applied at — sheet, row, column — rather than a
 * character offset into a file whose shape can move.
 */

/** Guard against a pathological file claiming an unbounded grid. */
export const MAX_ROWS = 200_000
export const MAX_COLUMNS = 2_048

/**
 * The one sheet a delimited file has.
 *
 * It needs a name because the redaction model addresses cells by worksheet,
 * and this is the name a reviewer sees above the grid.
 */
export const DELIMITED_SHEET_NAME = "Data"

export const DELIMITERS: Record<"csv" | "tsv", Delimiter> = {
  csv: ",",
  tsv: "\t",
}

export type DelimitedExtraction = {
  document: NormalizedDocument
  parsed: DelimitedDocument
}

export function delimiterFor(kind: DocumentKind): Delimiter {
  return kind === "tsv" ? DELIMITERS.tsv : DELIMITERS.csv
}

function sheetFrom(parsed: DelimitedDocument): SpreadsheetSheet {
  const rowCount = Math.min(parsed.rows.length, MAX_ROWS)
  const columnCount = Math.min(
    parsed.rows.reduce((widest, row) => Math.max(widest, row.length), 0),
    MAX_COLUMNS
  )

  const cells: SpreadsheetCell[] = []

  for (let row = 0; row < rowCount; row++) {
    const fields = parsed.rows[row]
    for (let column = 0; column < Math.min(fields.length, columnCount); column++) {
      const value = fields[column].value
      // An empty cell is not a cell: it costs nothing to process and holds
      // nothing to leak, and counting it would bill the blanks.
      if (value.length === 0) continue
      cells.push({ row: row + 1, column: column + 1, value })
    }
  }

  const header = parsed.rows[0] ?? []
  const headers: (string | null)[] = []
  for (let column = 0; column < columnCount; column++) {
    const value = header[column]?.value ?? ""
    headers.push(value.length > 0 ? value : null)
  }

  return {
    name: DELIMITED_SHEET_NAME,
    rowCount,
    columnCount,
    headers,
    cells,
  }
}

export function extractDelimited(
  documentId: string,
  kind: "csv" | "tsv",
  bytes: Uint8Array
): DelimitedExtraction {
  const { text, bom } = decodeText(bytes)
  const parsed = parseDelimited(text, delimiterFor(kind), { bom })

  if (parsed.rows.length > MAX_ROWS) {
    throw new Error(
      `File has more than ${MAX_ROWS} rows, which is beyond what can be reviewed`
    )
  }

  const sheet = sheetFrom(parsed)

  return {
    parsed,
    document: {
      documentId,
      kind,
      // Grids have no pages, exactly as a workbook has none.
      pages: [],
      sheets: [sheet],
      metadata: {
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        delimiter: kind === "tsv" ? "tab" : "comma",
        lineEnding: parsed.eol === "\r\n" ? "crlf" : "lf",
      },
    },
  }
}
