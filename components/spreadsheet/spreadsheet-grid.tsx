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
 */

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
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
          {sheets.map((candidate) => (
            <button
              key={candidate.name}
              type="button"
              onClick={() => dispatch(sheetChanged(candidate.name))}
              className={cn(
                "rounded-full px-3 py-1 text-xs transition-colors",
                candidate.name === sheet.name
                  ? "bg-red-soft text-primary"
                  : "text-text-muted hover:text-white"
              )}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      ) : null}

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
                        <EyeOff className="size-3 text-neutral-400" />
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
                          <EyeOff className="size-3 text-neutral-400" />
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
