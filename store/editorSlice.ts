import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

export type EditorTool = "select" | "redact" | "pan"

type EditorState = {
  currentPage: number
  zoom: number
  tool: EditorTool
  activeSheet: string | null
  fitMode: "width" | "page" | "custom"
  inspectorOpen: boolean
}

const initialState: EditorState = {
  currentPage: 1,
  zoom: 1,
  tool: "select",
  activeSheet: null,
  fitMode: "width",
  inspectorOpen: true,
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
  inspectorToggled,
  editorReset,
} = editorSlice.actions

export default editorSlice.reducer
