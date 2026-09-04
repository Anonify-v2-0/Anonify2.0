import type ExcelJS from "exceljs"

import { cellText, loadWorkbook } from "@/lib/documents/xlsx/extract"

/**
 * XLSX redaction.
 *
 * Cells are rewritten, not covered. A redacted cell loses its value and, if it
 * had one, its formula — a formula that still referenced the original would
 * hand the value straight back. Formatting, column widths, merges and the rest
 * of the workbook structure are left alone.
 */

export type CellAddress = { sheet: string; row: number; column: number }

export type XlsxRedactionPlan = {
  cells: CellAddress[]
  rows: { sheet: string; row: number }[]
  columns: { sheet: string; column: number }[]
  /** Values removed wherever they appear, including hidden sheets. */
  values: string[]
  label: string | null
  sanitizeMetadata: boolean
}

const REDACTED = "[REDACTED]"

function blankCell(cell: ExcelJS.Cell, label: string | null): void {
  // Assigning a plain value drops any formula that produced the old one, so
  // the original cannot be recomputed or read from a cached result.
  cell.value = label ?? null
}

function sheetOf(
  workbook: ExcelJS.Workbook,
  name: string
): ExcelJS.Worksheet | undefined {
  return workbook.getWorksheet(name)
}

/**
 * Drops formulas that still name a redacted cell. Excel caches results, and a
 * surviving reference is a second copy of the value the user asked to remove.
 */
function clearDependentFormulas(
  worksheet: ExcelJS.Worksheet,
  redactedAddresses: Set<string>
): void {
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const formula =
        cell.formula ??
        (typeof cell.value === "object" &&
        cell.value !== null &&
        "formula" in cell.value
          ? String(cell.value.formula)
          : undefined)

      if (!formula) return

      const references = formula.toUpperCase().match(/\$?[A-Z]{1,3}\$?\d{1,7}/g)
      if (!references) return

      const touchesRedacted = references.some((reference) =>
        redactedAddresses.has(reference.replace(/\$/g, ""))
      )
      if (touchesRedacted) cell.value = null
    })
  })
}

export async function redactXlsx(
  bytes: Uint8Array,
  plan: XlsxRedactionPlan
): Promise<Uint8Array> {
  const workbook = await loadWorkbook(bytes)
  const label = plan.label

  const redactedBySheet = new Map<string, Set<string>>()
  const markRedacted = (sheet: string, cell: ExcelJS.Cell) => {
    const set = redactedBySheet.get(sheet) ?? new Set<string>()
    set.add(cell.address.replace(/\$/g, "").toUpperCase())
    redactedBySheet.set(sheet, set)
  }

  for (const target of plan.columns) {
    const worksheet = sheetOf(workbook, target.sheet)
    if (!worksheet) continue
    // Row 1 is the header; redacting a column removes its data, not its name.
    for (let row = 2; row <= worksheet.rowCount; row++) {
      const cell = worksheet.getRow(row).getCell(target.column)
      if (cellText(cell.value) === null && !cell.formula) continue
      blankCell(cell, label)
      markRedacted(target.sheet, cell)
    }
  }

  for (const target of plan.rows) {
    const worksheet = sheetOf(workbook, target.sheet)
    if (!worksheet) continue
    const row = worksheet.getRow(target.row)
    for (let column = 1; column <= worksheet.columnCount; column++) {
      const cell = row.getCell(column)
      if (cellText(cell.value) === null && !cell.formula) continue
      blankCell(cell, label)
      markRedacted(target.sheet, cell)
    }
  }

  for (const target of plan.cells) {
    const worksheet = sheetOf(workbook, target.sheet)
    if (!worksheet) continue
    const cell = worksheet.getRow(target.row).getCell(target.column)
    blankCell(cell, label)
    markRedacted(target.sheet, cell)
  }

  // Safety net: the accepted values, everywhere else in the workbook —
  // including sheets and rows the editor never displayed.
  if (plan.values.length > 0) {
    workbook.eachSheet((worksheet) => {
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const text = cellText(cell.value)
          if (!text) return
          const hit = plan.values.some((value) =>
            text.toLowerCase().includes(value.toLowerCase())
          )
          if (!hit) return

          const cleaned = plan.values.reduce(
            (accumulator, value) =>
              accumulator.replace(
                new RegExp(escapeRegExp(value), "gi"),
                label ?? ""
              ),
            text
          )
          cell.value = cleaned.trim().length > 0 ? cleaned : (label ?? null)
          markRedacted(worksheet.name, cell)
        })
      })
    })
  }

  workbook.eachSheet((worksheet) => {
    const redacted = redactedBySheet.get(worksheet.name)
    if (redacted && redacted.size > 0) {
      clearDependentFormulas(worksheet, redacted)
    }
  })

  if (plan.sanitizeMetadata) {
    workbook.creator = ""
    workbook.lastModifiedBy = ""
    workbook.company = ""
    workbook.manager = ""
    workbook.title = ""
    workbook.subject = ""
    workbook.keywords = ""
    workbook.description = ""
  }

  const output = await workbook.xlsx.writeBuffer()
  return new Uint8Array(output)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export { REDACTED }
