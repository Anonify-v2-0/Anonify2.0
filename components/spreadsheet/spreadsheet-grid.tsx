"use client"

import { useMemo } from "react"
import { EyeOff, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  cellSelected,
  columnSelected,
  rowSelected,
  selectionCleared,
  sheetChanged,
} from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectRedactions } from "@/store/selectors"
import { normalizeValue } from "@/lib/documents/shared/text"
import { cn } from "@/lib/utils"
import type { NormalizedDocument, SpreadsheetSheet } from "@/types/document"
import type { Redaction } from "@/types/redaction"

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
 *
 * Redactions are drawn here for the same reason they are drawn on a page: this
 * grid is a promise about what the exported workbook will contain. It used to
 * make no such promise — accepted redactions were invisible, so a reviewer
 * accepted a suggestion in the inspector and the sheet in front of them did not
 * change — and selecting cells did nothing at all, because nothing consumed the
 * selection the grid was so careful to model.
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

type CellState = "accepted" | "suggested" | null

/**
 * What the exporter will do to this sheet, resolved once per render.
 *
 * It has to agree with lib/documents/xlsx/redact.ts exactly, including the
 * parts that are easy to forget: a redacted column keeps its header, and an
 * accepted value is swept from every cell holding it, which is how a name gets
 * removed from the hidden sheet nobody opened.
 */
function sheetRedactions(sheetName: string, redactions: Redaction[]) {
  const cells = { accepted: new Set<string>(), suggested: new Set<string>() }
  const rows = { accepted: new Set<number>(), suggested: new Set<number>() }
  const columns = { accepted: new Set<number>(), suggested: new Set<number>() }
  const values = { accepted: new Set<string>(), suggested: new Set<string>() }

  for (const redaction of redactions) {
    if (redaction.status === "rejected") continue
    const bucket = redaction.status === "accepted" ? "accepted" : "suggested"
    const positional = redaction.type === "row" || redaction.type === "column"

    // A value is swept workbook-wide, so it counts on every sheet. Anything
    // positional belongs only to the sheet it names — and its text is a header,
    // not content, which is why it is not collected as a value.
    const text = redaction.text?.trim()
    if (text && text.length >= 2 && !positional) {
      values[bucket].add(normalizeValue(text))
    }

    if (redaction.worksheet !== sheetName) continue

    if (redaction.type === "column" && redaction.column) {
      columns[bucket].add(redaction.column)
    } else if (redaction.type === "row" && redaction.row) {
      rows[bucket].add(redaction.row)
    } else if (redaction.row && redaction.column) {
      cells[bucket].add(cellKey(redaction.row, redaction.column))
    }
  }

  return function stateOf(
    row: number,
    column: number,
    value: string | null
  ): CellState {
    const normalized = value ? normalizeValue(value) : ""

    const matches = (bucket: "accepted" | "suggested") =>
      cells[bucket].has(cellKey(row, column)) ||
      rows[bucket].has(row) ||
      // Row 1 is the header, and a column redaction removes its data, not its
      // name — the same line the exporter draws.
      (row > 1 && columns[bucket].has(column)) ||
      (normalized.length > 0 && values[bucket].has(normalized))

    if (matches("accepted")) return "accepted"
    if (matches("suggested")) return "suggested"
    return null
  }
}

export type SpreadsheetActions = {
  create: (input: Omit<Redaction, "id" | "documentId">) => void
}

export function SpreadsheetGrid({
  normalized,
  actions,
}: {
  normalized: NormalizedDocument
  actions?: SpreadsheetActions
}) {
  const dispatch = useAppDispatch()
  const { activeSheet, selection } = useAppSelector((state) => state.editor)
  const redactions = useAppSelector(selectRedactions)

  const sheets = normalized.sheets ?? []
  const sheet =
    sheets.find((candidate) => candidate.name === activeSheet) ?? sheets[0]

  const cells = useMemo(() => (sheet ? buildCellMap(sheet) : new Map()), [sheet])
  const stateOf = useMemo(
    () => sheetRedactions(sheet?.name ?? "", redactions),
    [redactions, sheet?.name]
  )

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

  const selectionCount =
    selection.cells.length + selection.rows.length + selection.columns.length

  /**
   * Turns the selection into redactions.
   *
   * The grid modelled cells, rows and columns from the start and nothing ever
   * consumed that: a reviewer could select a column of account numbers and had
   * no way to act on it. These are created accepted, because selecting a column
   * and pressing Redact *is* the human decision — there is nobody else to
   * review it.
   */
  function redactSelection() {
    if (!actions) return

    for (const column of selection.columns) {
      actions.create({
        type: "column",
        source: "user",
        category: "other",
        status: "accepted",
        worksheet: sheet.name,
        column,
        text: sheet.headers[column - 1] ?? columnLabel(column),
      })
    }

    for (const row of selection.rows) {
      actions.create({
        type: "row",
        source: "user",
        category: "other",
        status: "accepted",
        worksheet: sheet.name,
        row,
      })
    }

    for (const cell of selection.cells) {
      actions.create({
        type: "cell",
        source: "user",
        category: "other",
        status: "accepted",
        worksheet: sheet.name,
        row: cell.row,
        column: cell.column,
        // Carried so the value is swept from wherever else it appears —
        // including the sheets this reviewer never opened.
        text: cells.get(cellKey(cell.row, cell.column)) ?? undefined,
      })
    }

    dispatch(selectionCleared())
  }

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

      {actions && selectionCount > 0 ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
          <span className="text-xs text-text-secondary">
            {[
              selection.cells.length > 0
                ? countLabel(selection.cells.length, "cell")
                : null,
              selection.rows.length > 0
                ? countLabel(selection.rows.length, "row")
                : null,
              selection.columns.length > 0
                ? countLabel(selection.columns.length, "column")
                : null,
            ]
              .filter(Boolean)
              .join(", ")}{" "}
            selected
          </span>
          <Button size="xs" variant="outline" onClick={redactSelection}>
            <Square className="size-3" />
            Redact
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => dispatch(selectionCleared())}
          >
            Clear
          </Button>
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
                      const value = cells.get(cellKey(row, column)) ?? null
                      const isSelected =
                        selectedCells.has(cellKey(row, column)) ||
                        rowSelectedState ||
                        selectedColumns.has(column)
                      const state = stateOf(row, column, value)

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
                          title={
                            state === "accepted"
                              ? "Redacted: this cell is empty in the export"
                              : state === "suggested"
                                ? "Suggested for redaction"
                                : undefined
                          }
                          className={cn(
                            "max-w-[260px] truncate border-r border-b border-neutral-200 px-2 py-1 transition-colors",
                            state === "accepted" && "bg-black text-black",
                            state === "suggested" &&
                              "bg-primary/15 outline-1 -outline-offset-1 outline-dashed outline-red-border",
                            isSelected
                              ? "outline-1 -outline-offset-1 outline-primary"
                              : state === null
                                ? "hover:bg-neutral-50"
                                : null,
                            state === null &&
                              (hiddenRows.has(row) || hiddenColumns.has(column)) &&
                              "text-neutral-400 italic"
                          )}
                        >
                          {/*
                            The value leaves the DOM rather than being covered.
                            A black background over live text is the exact
                            failure this project exists to refuse, and it would
                            survive a copy-paste and a screenshot alike.
                          */}
                          {state === "accepted" ? "" : (value ?? "")}
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
