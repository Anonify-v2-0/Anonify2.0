import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

export type EditorTool = "select" | "redact" | "pan"

/** What the user currently has marked in the spreadsheet grid. */
export type GridSelection = {
  sheet: string | null
  cells: { row: number; column: number }[]
  rows: number[]
  columns: number[]
}

const emptySelection: GridSelection = {
  sheet: null,
  cells: [],
  rows: [],
  columns: [],
}

type EditorState = {
  currentPage: number
  zoom: number
  tool: EditorTool
  activeSheet: string | null
  fitMode: "width" | "page" | "custom"
  inspectorOpen: boolean
  selection: GridSelection
}

const initialState: EditorState = {
  currentPage: 1,
  zoom: 1,
  tool: "select",
  activeSheet: null,
  fitMode: "width",
  inspectorOpen: true,
  selection: emptySelection,
}

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4

const editorSlice = createSlice({
  name: "editor",
  initialState,
  reducers: {
    pageChanged(state, action: PayloadAction<number>) {
      state.currentPage = Math.max(1, action.payload)
    },
    zoomChanged(state, action: PayloadAction<number>) {
      state.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, action.payload))
      state.fitMode = "custom"
    },
    zoomStepped(state, action: PayloadAction<number>) {
      state.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom + action.payload))
      state.fitMode = "custom"
    },
    fitModeChanged(state, action: PayloadAction<"width" | "page">) {
      state.fitMode = action.payload
    },
    toolChanged(state, action: PayloadAction<EditorTool>) {
      state.tool = action.payload
    },
    sheetChanged(state, action: PayloadAction<string | null>) {
      state.activeSheet = action.payload
      state.selection = { ...emptySelection, sheet: action.payload }
    },
    cellSelected(
      state,
      action: PayloadAction<{
        sheet: string
        row: number
        column: number
        additive?: boolean
      }>
    ) {
      const { sheet, row, column, additive } = action.payload
      const base =
        additive && state.selection.sheet === sheet
          ? state.selection
          : { ...emptySelection, sheet }

      const already = base.cells.some(
        (cell) => cell.row === row && cell.column === column
      )

      state.selection = {
        ...base,
        sheet,
        cells: already
          ? base.cells.filter(
              (cell) => !(cell.row === row && cell.column === column)
            )
          : [...base.cells, { row, column }],
      }
    },
    rowSelected(
      state,
      action: PayloadAction<{ sheet: string; row: number; additive?: boolean }>
    ) {
      const { sheet, row, additive } = action.payload
      const base =
        additive && state.selection.sheet === sheet
          ? state.selection
          : { ...emptySelection, sheet }

      state.selection = {
        ...base,
        sheet,
        rows: base.rows.includes(row)
          ? base.rows.filter((candidate) => candidate !== row)
          : [...base.rows, row],
      }
    },
    columnSelected(
      state,
      action: PayloadAction<{
        sheet: string
        column: number
        additive?: boolean
      }>
    ) {
      const { sheet, column, additive } = action.payload
      const base =
        additive && state.selection.sheet === sheet
          ? state.selection
          : { ...emptySelection, sheet }

      state.selection = {
        ...base,
        sheet,
        columns: base.columns.includes(column)
          ? base.columns.filter((candidate) => candidate !== column)
          : [...base.columns, column],
      }
    },
    selectionCleared(state) {
      state.selection = { ...emptySelection, sheet: state.activeSheet }
    },
    inspectorToggled(state, action: PayloadAction<boolean | undefined>) {
      state.inspectorOpen = action.payload ?? !state.inspectorOpen
    },
    editorReset() {
      return initialState
    },
  },
})

export const {
  pageChanged,
  zoomChanged,
  zoomStepped,
  fitModeChanged,
  toolChanged,
  sheetChanged,
  cellSelected,
  rowSelected,
  columnSelected,
  selectionCleared,
  inspectorToggled,
  editorReset,
} = editorSlice.actions

export default editorSlice.reducer
