import ExcelJS from "exceljs"

import type {
  NormalizedDocument,
  SheetVisibility,
  SpreadsheetCell,
  SpreadsheetSheet,
} from "@/types/document"

/**
 * XLSX extraction.
 *
 * A workbook is structure first and prose second, so this reads it as a grid:
 * headers, used ranges, formulas, merges and — importantly — the rows, columns
 * and sheets that are hidden. Hidden data is exactly where a redaction is most
 * likely to be missed, so it is extracted like everything else rather than
 * quietly skipped.
 */

/** Guard against a corrupt sheet claiming millions of empty rows. */
const MAX_ROWS = 20_000
const MAX_COLUMNS = 512

export function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null

  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  if (value instanceof Date) return value.toISOString()

  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("")
    }
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue)
    if ("hyperlink" in value && typeof value.hyperlink === "string") {
      return value.hyperlink
    }
    if ("formula" in value) return null
  }

  return null
}

function readSheet(worksheet: ExcelJS.Worksheet): SpreadsheetSheet {
  const rowCount = Math.min(worksheet.rowCount, MAX_ROWS)
  const columnCount = Math.min(worksheet.columnCount, MAX_COLUMNS)

  const cells: SpreadsheetCell[] = []
  const hiddenRows: number[] = []
  const hiddenColumns: number[] = []

  for (let row = 1; row <= rowCount; row++) {
    const worksheetRow = worksheet.getRow(row)
    if (worksheetRow.hidden) hiddenRows.push(row)

    for (let column = 1; column <= columnCount; column++) {
      const cell = worksheetRow.getCell(column)
      const value = cellText(cell.value)
      const formula =
        cell.formula ??
        (typeof cell.value === "object" &&
        cell.value !== null &&
        "formula" in cell.value
          ? String(cell.value.formula)
          : undefined)

      if (value === null && !formula) continue

      cells.push({
        row,
        column,
        value,
        formula,
        numberFormat: cell.numFmt,
      })
    }
  }

  for (let column = 1; column <= columnCount; column++) {
    if (worksheet.getColumn(column).hidden) hiddenColumns.push(column)
  }

  const headerRow = worksheet.getRow(1)
  const headers: (string | null)[] = []
  for (let column = 1; column <= columnCount; column++) {
    headers.push(cellText(headerRow.getCell(column).value))
  }

  return {
    name: worksheet.name,
    rowCount,
    columnCount,
    headers,
    cells,
    mergedRanges: Object.keys(
      (worksheet as unknown as { _merges?: Record<string, unknown> })._merges ?? {}
    ),
    hiddenRows: hiddenRows.length > 0 ? hiddenRows : undefined,
    hiddenColumns: hiddenColumns.length > 0 ? hiddenColumns : undefined,
    // Carried through to the editor rather than used here: the redactor already
    // treats every sheet alike, but a reviewer looking at a grid has no way to
    // tell that these rows are ones nobody opening the workbook would see.
    visibility: sheetVisibility(worksheet),
  }
}

function sheetVisibility(
  worksheet: ExcelJS.Worksheet
): SheetVisibility | undefined {
  return worksheet.state === "hidden" || worksheet.state === "veryHidden"
    ? worksheet.state
    : undefined
}

export async function loadWorkbook(
  bytes: Uint8Array
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  // Buffer is a Uint8Array view; exceljs wants an ArrayBuffer-backed buffer.
  await workbook.xlsx.load(
    Buffer.from(bytes).buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
  )
  return workbook
}

export type XlsxExtraction = {
  document: NormalizedDocument
  cellCount: number
}

export async function extractXlsx(
  documentId: string,
  bytes: Uint8Array
): Promise<XlsxExtraction> {
  const workbook = await loadWorkbook(bytes)
  const sheets: SpreadsheetSheet[] = []

  workbook.eachSheet((worksheet) => {
    sheets.push(readSheet(worksheet))
  })

  if (sheets.length === 0) {
    throw new Error("Workbook has no readable worksheets")
  }

  return {
    document: {
      documentId,
      kind: "xlsx",
      pages: [],
      sheets,
      metadata: {
        sheetCount: sheets.length,
        workbookName: workbook.title ?? undefined,
      },
    },
    cellCount: sheets.reduce((total, sheet) => total + sheet.cells.length, 0),
  }
}
