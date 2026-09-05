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
    /**
     * A failure that arrived on the processing stream rather than in the server
     * render. Without this the workspace knows it failed and not why, and the
     * failure notice falls back to its generic sentence while the real one sits
     * in the event that just came in.
     */
    documentFailureRecorded(
      state,
      action: PayloadAction<{ message: string; code: string | null }>
    ) {
      if (!state.summary) return
      state.summary.status = "failed"
      state.summary.error = action.payload.message
      state.summary.errorCode = action.payload.code
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
  documentFailureRecorded,
  normalizedLoaded,
  documentFailed,
  documentCleared,
} = documentSlice.actions

export default documentSlice.reducer
