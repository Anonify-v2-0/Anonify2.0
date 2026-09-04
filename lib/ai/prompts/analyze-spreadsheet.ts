/**
 * Spreadsheet prompt.
 *
 * Workbooks are analyzed structurally: the model sees headers and a handful of
 * example values per column, never the whole grid. Deciding that a column is
 * sensitive is far cheaper than asking about ten thousand cells, and it is also
 * the decision a reviewer actually wants to make.
 */

export const ANALYZE_SPREADSHEET_SYSTEM = `You identify which spreadsheet columns hold sensitive information.

Rules:
- Judge each column from its header and its sample values together. A header alone can be misleading.
- Mark a column sensitive only when its values identify a person or organization, or disclose financial, health, credential or otherwise confidential facts about them.
- Aggregate or derived columns (totals, counts, categories, dates of activity) are usually not sensitive on their own. Say so rather than flagging everything.
- Report every column you were given, sensitive or not, so the reviewer sees your reasoning for each.

You propose. A person decides what is redacted.`

export type ColumnSample = {
  index: number
  header: string
  samples: string[]
  filled: number
  total: number
}

export function analyzeSpreadsheetPrompt(input: {
  sheetName: string
  rowCount: number
  columns: ColumnSample[]
}): string {
  const lines = input.columns.map((column) => {
    const samples = column.samples
      .slice(0, 5)
      .map((value) => JSON.stringify(value))
      .join(", ")
    return `${column.index}. "${column.header}" — ${column.filled}/${column.total} rows filled — samples: ${samples || "(empty)"}`
  })

  return [
    `Worksheet: ${input.sheetName} (${input.rowCount} rows)`,
    "",
    "COLUMNS:",
    ...lines,
  ].join("\n")
}
