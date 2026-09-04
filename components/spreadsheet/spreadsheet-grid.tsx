"use client"

import { useMemo } from "react"
import { EyeOff } from "lucide-react"

import { ScrollArea } from "@/components/ui/scroll-area"
import {
  cellSelected,
  columnSelected,
  rowSelected,
  sheetChanged,
} from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { cn } from "@/lib/utils"
import type { NormalizedDocument, SpreadsheetSheet } from "@/types/document"

/**
 * The spreadsheet surface.
 *
 * Redaction in a workbook is structural, so the grid makes the unit explicit:
 * a cell, a whole row, or a whole column. Hidden rows and columns are shown
 * rather than skipped — data the user cannot see is exactly the data they are
 * most likely to leak.
 *
 * Hidden sheets get the same treatment as DOCX headers and footers: rendering
 * a hidden sheet exactly like a visible one is what makes it dangerous. The
 * reviewer needs to know that what they are reading is content the workbook
 * does not normally show, because that changes what they decide about it.
 */

const VISIBILITY_COPY = {
  hidden: {
    label: "Hidden sheet",
    detail:
      "This sheet is hidden in the workbook. Anyone who unhides it sees everything below.",
  },
  veryHidden: {
    label: "Very hidden sheet",
    detail:
      "This sheet is marked very hidden — it cannot be unhidden from Excel's sheet menu, only from the VBA editor. The data is still in the file.",
  },
} as const

/** 1 -> A, 27 -> AA. */
export function columnLabel(index: number): string {
  let label = ""
  let value = index
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

type CellMap = Map<string, string | null>

function cellKey(row: number, column: number): string {
  return `${row}:${column}`
}

function buildCellMap(sheet: SpreadsheetSheet): CellMap {
  const map: CellMap = new Map()
  for (const cell of sheet.cells) {
    map.set(cellKey(cell.row, cell.column), cell.value)
  }
  return map
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

/**
 * States what the grid cannot show by drawing it: that this sheet, or some of
 * its rows and columns, are ones the workbook keeps out of sight. Rendered
 * above the grid rather than as a tooltip, because a reviewer who has to hover
 * to find out has already read the sheet as if it were ordinary.
 */
function SheetNotice({ sheet }: { sheet: SpreadsheetSheet }) {
  const copy = sheet.visibility ? VISIBILITY_COPY[sheet.visibility] : null
  const hiddenRowCount = sheet.hiddenRows?.length ?? 0
  const hiddenColumnCount = sheet.hiddenColumns?.length ?? 0

  if (!copy && hiddenRowCount === 0 && hiddenColumnCount === 0) return null

  const withinSheet = [
    hiddenRowCount > 0 ? countLabel(hiddenRowCount, "hidden row") : null,
    hiddenColumnCount > 0 ? countLabel(hiddenColumnCount, "hidden column") : null,
  ].filter(Boolean) as string[]

  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-red-border bg-red-soft px-4 py-2 text-xs text-text-secondary">
      <EyeOff aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <p>
        {copy ? (
          <>
            <span className="font-medium text-primary">{copy.label}.</span>{" "}
            {copy.detail}{" "}
          </>
        ) : null}
        {withinSheet.length > 0 ? (
          <>
            {withinSheet.join(" and ")} on this sheet
            {copy ? "" : ", shown here and marked in the gutter"}. They are
            extracted, reviewable and redacted like everything else.
          </>
        ) : null}
      </p>
    </div>
  )
}

export function SpreadsheetGrid({
  normalized,
}: {
  normalized: NormalizedDocument
}) {
  const dispatch = useAppDispatch()
  const { activeSheet, selection } = useAppSelector((state) => state.editor)

  const sheets = normalized.sheets ?? []
  const sheet =
    sheets.find((candidate) => candidate.name === activeSheet) ?? sheets[0]

  const cells = useMemo(() => (sheet ? buildCellMap(sheet) : new Map()), [sheet])

  if (!sheet) {
    return (
      <section className="flex flex-1 items-center justify-center bg-surface-1 text-sm text-text-muted">
        This workbook has no readable sheets.
      </section>
    )
  }

  const hiddenRows = new Set(sheet.hiddenRows ?? [])
  const hiddenColumns = new Set(sheet.hiddenColumns ?? [])
  const selectedRows = new Set(selection.rows)
  const selectedColumns = new Set(selection.columns)
  const selectedCells = new Set(
    selection.cells.map((cell) => cellKey(cell.row, cell.column))
  )

  const rows = Array.from({ length: sheet.rowCount }, (_, index) => index + 1)
  const columns = Array.from(
    { length: sheet.columnCount },
    (_, index) => index + 1
  )

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-surface-1">
      {sheets.length > 1 ? (
        <div
          role="tablist"
          aria-label="Worksheets"
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-2"
        >
          {sheets.map((candidate) => {
            const active = candidate.name === sheet.name
            const copy = candidate.visibility
              ? VISIBILITY_COPY[candidate.visibility]
              : null

            return (
              <button
                key={candidate.name}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => dispatch(sheetChanged(candidate.name))}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors",
                  active
                    ? "bg-red-soft text-primary"
                    : "text-text-muted hover:text-white"
                )}
              >
                {copy ? <EyeOff aria-hidden className="size-3" /> : null}
                {candidate.name}
                {copy ? <span className="sr-only"> ({copy.label})</span> : null}
              </button>
            )
          })}
        </div>
      ) : null}

      <SheetNotice sheet={sheet} />

      <ScrollArea className="flex-1">
        <div className="min-w-max p-4">
          <table className="border-separate border-spacing-0 bg-document text-[13px] text-document-foreground shadow-document">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 w-10 border-r border-b border-neutral-300 bg-neutral-100 px-2 py-1 text-[11px] font-medium text-neutral-500" />
                {columns.map((column) => (
                  <th
                    key={column}
                    onClick={(event) =>
                      dispatch(
                        columnSelected({
                          sheet: sheet.name,
                          column,
                          additive: event.metaKey || event.ctrlKey,
                        })
                      )
                    }
                    className={cn(
                      "min-w-[120px] cursor-pointer border-r border-b border-neutral-300 px-2 py-1 text-left text-[11px] font-medium transition-colors",
                      selectedColumns.has(column)
                        ? "bg-primary/15 text-primary"
                        : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
                    )}
                  >
                    <span className="flex items-center gap-1">
                      {columnLabel(column)}
                      {sheet.headers[column - 1] ? (
                        <span className="truncate font-normal text-neutral-600">
                          · {sheet.headers[column - 1]}
                        </span>
                      ) : null}
                      {hiddenColumns.has(column) ? (
                        <>
                          <EyeOff
                            aria-hidden
                            className="size-3 text-neutral-400"
                          />
                          <span className="sr-only">(hidden column)</span>
                        </>
                      ) : null}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => {
                const rowSelectedState = selectedRows.has(row)
                return (
                  <tr key={row}>
                    <th
                      onClick={(event) =>
                        dispatch(
                          rowSelected({
                            sheet: sheet.name,
                            row,
                            additive: event.metaKey || event.ctrlKey,
                          })
                        )
                      }
                      className={cn(
                        "sticky left-0 z-10 cursor-pointer border-r border-b border-neutral-300 px-2 py-1 text-right text-[11px] font-medium transition-colors",
                        rowSelectedState
                          ? "bg-primary/15 text-primary"
                          : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
                      )}
                    >
                      <span className="flex items-center justify-end gap-1">
                        {hiddenRows.has(row) ? (
                          <>
                            <EyeOff
                              aria-hidden
                              className="size-3 text-neutral-400"
                            />
                            <span className="sr-only">(hidden row)</span>
                          </>
                        ) : null}
                        {row}
                      </span>
                    </th>

                    {columns.map((column) => {
                      const value = cells.get(cellKey(row, column))
                      const isSelected =
                        selectedCells.has(cellKey(row, column)) ||
                        rowSelectedState ||
                        selectedColumns.has(column)

                      return (
                        <td
                          key={column}
                          onClick={(event) =>
                            dispatch(
                              cellSelected({
                                sheet: sheet.name,
                                row,
                                column,
                                additive: event.metaKey || event.ctrlKey,
                              })
                            )
                          }
                          className={cn(
                            "max-w-[260px] truncate border-r border-b border-neutral-200 px-2 py-1 transition-colors",
                            isSelected
                              ? "bg-primary/10 outline-1 -outline-offset-1 outline-primary"
                              : "hover:bg-neutral-50",
                            (hiddenRows.has(row) || hiddenColumns.has(column)) &&
                              "text-neutral-400 italic"
                          )}
                        >
                          {value ?? ""}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </ScrollArea>
    </section>
  )
}
