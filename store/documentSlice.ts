import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type { DocumentSummary, NormalizedDocument } from "@/types/document"

type DocumentState = {
  summary: DocumentSummary | null
  normalized: NormalizedDocument | null
  loading: boolean
  error: string | null
}

const initialState: DocumentState = {
  summary: null,
  normalized: null,
  loading: false,
  error: null,
}

const documentSlice = createSlice({
  name: "document",
  initialState,
  reducers: {
    documentLoading(state) {
      state.loading = true
      state.error = null
    },
    documentLoaded(state, action: PayloadAction<DocumentSummary>) {
      state.summary = action.payload
      state.loading = false
      state.error = null
    },
    documentStatusChanged(state, action: PayloadAction<string>) {
      if (state.summary) state.summary.status = action.payload
    },
    normalizedLoaded(state, action: PayloadAction<NormalizedDocument>) {
      state.normalized = action.payload
    },
    documentFailed(state, action: PayloadAction<string>) {
      state.loading = false
      state.error = action.payload
    },
    documentCleared() {
      return initialState
    },
  },
})

export const {
  documentLoading,
  documentLoaded,
  documentStatusChanged,
  normalizedLoaded,
  documentFailed,
  documentCleared,
} = documentSlice.actions

export default documentSlice.reducer
