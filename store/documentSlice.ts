import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type {
  DocumentSummary,
  NormalizedOutline,
  NormalizedPage,
} from "@/types/document"

/**
 * How many pages the editor keeps once it has fetched them.
 *
 * Enough for the page on the canvas, the ones either side of it and a rail of
 * thumbnails; not so many that a long document ends up held whole after all,
 * which is what loading it a page at a time exists to avoid.
 */
export const PAGE_CACHE_LIMIT = 24

type DocumentState = {
  summary: DocumentSummary | null
  /** The model without its pages; see `NormalizedOutline`. */
  normalized: NormalizedOutline | null
  /** Pages fetched so far, by number, for the outline's document. */
  pages: Record<number, NormalizedPage>
  /** Page numbers in `pages`, least recently used first. */
  pageOrder: number[]
  loading: boolean
  error: string | null
}

const initialState: DocumentState = {
  summary: null,
  normalized: null,
  pages: {},
  pageOrder: [],
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
    normalizedLoaded(state, action: PayloadAction<NormalizedOutline>) {
      state.normalized = action.payload
      state.pages = {}
      state.pageOrder = []
    },
    /**
     * A page arrived. One for a document that is no longer open is dropped,
     * and past the cache limit the page used longest ago is let go; it is
     * fetched again if it is looked at again.
     */
    pageLoaded(
      state,
      action: PayloadAction<{ documentId: string; page: NormalizedPage }>
    ) {
      const { documentId, page } = action.payload
      if (state.normalized?.documentId !== documentId) return

      state.pages[page.number] = page
      state.pageOrder = [
        ...state.pageOrder.filter((number) => number !== page.number),
        page.number,
      ]
      while (state.pageOrder.length > PAGE_CACHE_LIMIT) {
        const evicted = state.pageOrder.shift()
        if (evicted !== undefined) delete state.pages[evicted]
      }
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
  pageLoaded,
  documentFailed,
  documentCleared,
} = documentSlice.actions

export default documentSlice.reducer
