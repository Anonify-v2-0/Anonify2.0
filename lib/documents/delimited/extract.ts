import {
  decodeText,
  DelimitedParser,
  parseDelimited,
  TextDecodingStream,
  type DelimitedDocument,
  type DelimitedField,
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

/** Every non-empty cell of one row, in the model's shape. */
function cellsOf(fields: DelimitedField[], row: number): SpreadsheetCell[] {
  const cells: SpreadsheetCell[] = []
  // `MAX_COLUMNS` rather than the widest row: a row can be no wider than the
  // widest, so the two bounds only ever differ at the cap.
  for (let column = 0; column < Math.min(fields.length, MAX_COLUMNS); column++) {
    const value = fields[column].value
    // An empty cell is not a cell: it costs nothing to process and holds
    // nothing to leak, and counting it would bill the blanks.
    if (value.length === 0) continue
    cells.push({ row: row + 1, column: column + 1, value })
  }
  return cells
}

/** The header row, as far as the sheet is wide. */
function headersOf(
  header: DelimitedField[] | undefined,
  columnCount: number
): (string | null)[] {
  const headers: (string | null)[] = []
  for (let column = 0; column < columnCount; column++) {
    const value = header?.[column]?.value ?? ""
    headers.push(value.length > 0 ? value : null)
  }
  return headers
}

function metadataOf(
  kind: "csv" | "tsv",
  rowCount: number,
  columnCount: number,
  eol: "\r\n" | "\n"
): Record<string, unknown> {
  return {
    rowCount,
    columnCount,
    delimiter: kind === "tsv" ? "tab" : "comma",
    lineEnding: eol === "\r\n" ? "crlf" : "lf",
  }
}

function tooManyRows(): Error {
  return new Error(
    `File has more than ${MAX_ROWS} rows, which is beyond what can be reviewed`
  )
}

function sheetFrom(parsed: DelimitedDocument): SpreadsheetSheet {
  const rowCount = Math.min(parsed.rows.length, MAX_ROWS)
  const columnCount = Math.min(
    parsed.rows.reduce((widest, row) => Math.max(widest, row.length), 0),
    MAX_COLUMNS
  )

  const cells: SpreadsheetCell[] = []
  for (let row = 0; row < rowCount; row++) {
    cells.push(...cellsOf(parsed.rows[row], row))
  }

  // Cells first, so the streaming extractor below — which only knows the
  // counts and the headers once every row has gone past — writes the same
  // object, key for key.
  return {
    name: DELIMITED_SHEET_NAME,
    cells,
    rowCount,
    columnCount,
    headers: headersOf(parsed.rows[0], columnCount),
  }
}

export function extractDelimited(
  documentId: string,
  kind: "csv" | "tsv",
  bytes: Uint8Array
): DelimitedExtraction {
  const { text, bom } = decodeText(bytes)
  const parsed = parseDelimited(text, delimiterFor(kind), { bom })

  if (parsed.rows.length > MAX_ROWS) throw tooManyRows()

  const sheet = sheetFrom(parsed)

  return {
    parsed,
    document: {
      documentId,
      kind,
      // Grids have no pages, exactly as a workbook has none.
      pages: [],
      sheets: [sheet],
      metadata: metadataOf(kind, sheet.rowCount, sheet.columnCount, parsed.eol),
    },
  }
}

/**
 * CSV and TSV extraction that never holds the file.
 *
 * Bytes go in a piece at a time and cells come out a row at a time, written
 * straight into the model's JSON; what `end` finishes is exactly what
 * `JSON.stringify(extractDelimited(...).document)` would have been. The only
 * row kept is the first, because it names the columns and the column count is
 * only known once the widest row has gone past.
 *
 * Refusals come out for the reason, and in the order, the whole-file
 * extraction gave them: invalid UTF-8, then control bytes, then an unclosed
 * quote, then too many rows. Several of those are only knowable at the end,
 * after cells have been written, and the caller discards what was written
 * when `end` throws. Rows past `MAX_ROWS` are counted and not kept.
 */
export class DelimitedExtractionStream {
  private readonly decoder = new TextDecodingStream()
  private readonly parser: DelimitedParser
  private out: string[] = []
  private rows = 0
  private widest = 0
  private cellCount = 0
  private header: DelimitedField[] | undefined

  constructor(
    documentId: string,
    private readonly kind: "csv" | "tsv"
  ) {
    this.parser = new DelimitedParser(delimiterFor(kind), (fields) =>
      this.row(fields)
    )
    this.out.push(
      `{"documentId":${JSON.stringify(documentId)},"kind":${JSON.stringify(kind)},` +
        `"pages":[],"sheets":[{"name":${JSON.stringify(DELIMITED_SHEET_NAME)},"cells":[`
    )
  }

  /** Cells written so far — the quantity a delimited file is charged by. */
  get cells(): number {
    return this.cellCount
  }

  /** Takes the next piece of the file; returns the JSON it completed. */
  write(bytes: Uint8Array): string {
    this.accept(this.decoder.write(bytes))
    return this.take()
  }

  /** Finishes the file; returns the rest of the JSON, or throws its refusal. */
  end(): string {
    this.accept(this.decoder.end())
    const { eol } = this.parser.end()
    if (this.rows > MAX_ROWS) throw tooManyRows()

    const rowCount = Math.min(this.rows, MAX_ROWS)
    const columnCount = Math.min(this.widest, MAX_COLUMNS)
    this.out.push(
      `],"rowCount":${rowCount},"columnCount":${columnCount},` +
        `"headers":${JSON.stringify(headersOf(this.header, columnCount))}}],` +
        `"metadata":${JSON.stringify(metadataOf(this.kind, rowCount, columnCount, eol))}}`
    )
    return this.take()
  }

  private accept(text: string): void {
    // Past a control byte the file is refused whatever the grid holds; the
    // decoder keeps going only to find an invalid sequence, which outranks it.
    if (this.decoder.refused) return
    this.parser.write(text)
  }

  private row(fields: DelimitedField[]): void {
    const index = this.rows
    this.rows += 1
    this.widest = Math.max(this.widest, fields.length)
    if (index === 0) this.header = fields
    if (index >= MAX_ROWS) return

    for (const cell of cellsOf(fields, index)) {
      this.out.push(this.cellCount === 0 ? "" : ",", JSON.stringify(cell))
      this.cellCount += 1
    }
  }

  private take(): string {
    const json = this.out.join("")
    this.out = []
    return json
  }
}
