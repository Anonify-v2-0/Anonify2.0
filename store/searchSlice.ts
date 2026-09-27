import {
  createSelector,
  createSlice,
  type PayloadAction,
} from "@reduxjs/toolkit"

import type { PatternSpec } from "@/lib/redaction/patterns"
import type {
  BatchSearchDocument,
  CellHit,
  SearchHit,
  SearchSummary,
} from "@/lib/redaction/search"

/**
 * Search in the review screen.
 *
 * The server holds the answer (see lib/redaction/search.ts); this holds which
 * question was asked, where its hits are, and which one the reviewer is on.
 * Every answer is stamped with the key of the question it answers, because a
 * reviewer types faster than a 400-page document is searched, and an answer
 * to "Smi" arriving after "Smith" must not be drawn as though it were.
 */

export type SearchStatus = "idle" | "searching" | "ready" | "error"

export type SearchState = {
  open: boolean
  /** Bumped to ask the box for focus, even when it is already open. */
  focusRequest: number
  query: string
  regex: boolean
  matchCase: boolean
  wholeWord: boolean
  /** The question the current answer is for. */
  key: string | null
  status: SearchStatus
  error: string | null
  total: number
  pages: SearchSummary["pages"]
  cells: CellHit[]
  cellsTruncated: boolean
  /** Hits per page, for the current key only. */
  pageHits: Record<number, SearchHit[]>
  /** Zero-based position among all hits; -1 before there is one. */
  current: number
  batch: {
    open: boolean
    status: SearchStatus
    key: string | null
    documents: BatchSearchDocument[]
    error: string | null
  }
}

const initialState: SearchState = {
  open: false,
  focusRequest: 0,
  query: "",
  regex: false,
  matchCase: false,
  wholeWord: false,
  key: null,
  status: "idle",
  error: null,
  total: 0,
  pages: [],
  cells: [],
  cellsTruncated: false,
  pageHits: {},
  current: -1,
  batch: { open: false, status: "idle", key: null, documents: [], error: null },
}

/** The question the options describe, as the server's pattern spec. */
export function specOfSearch(
  state: Pick<SearchState, "query" | "regex" | "matchCase" | "wholeWord">
): PatternSpec {
  return {
    kind: state.regex ? "regex" : "literal",
    pattern: state.query,
    matchCase: state.matchCase,
    wholeWord: state.wholeWord,
  }
}

export function searchKey(spec: PatternSpec): string {
  return JSON.stringify([
    spec.kind,
    spec.pattern,
    spec.matchCase,
    spec.wholeWord,
  ])
}

function clearResults(state: SearchState) {
  state.key = null
  state.status = "idle"
  state.error = null
  state.total = 0
  state.pages = []
  state.cells = []
  state.cellsTruncated = false
  state.pageHits = {}
  state.current = -1
  state.batch = { ...initialState.batch, open: state.batch.open }
}

const searchSlice = createSlice({
  name: "search",
  initialState,
  reducers: {
    searchOpened(state) {
      state.open = true
      state.focusRequest += 1
    },
    /** Closing clears the highlights; the query stays for the next open. */
    searchClosed(state) {
      state.open = false
      clearResults(state)
    },
    queryChanged(state, action: PayloadAction<string>) {
      state.query = action.payload
      if (!action.payload) clearResults(state)
    },
    optionsChanged(
      state,
      action: PayloadAction<
        Partial<Pick<SearchState, "regex" | "matchCase" | "wholeWord">>
      >
    ) {
      Object.assign(state, action.payload)
    },
    /** Replaces the query and options at once, e.g. from a Hush proposal. */
    searchSet(state, action: PayloadAction<PatternSpec>) {
      state.open = true
      state.focusRequest += 1
      state.query = action.payload.pattern
      state.regex = action.payload.kind === "regex"
      state.matchCase = action.payload.matchCase
      state.wholeWord = action.payload.wholeWord
    },
    searchStarted(state, action: PayloadAction<string>) {
      if (state.key !== action.payload) {
        state.pageHits = {}
        state.current = -1
      }
      state.key = action.payload
      state.status = "searching"
      state.error = null
    },
    searchSucceeded(
      state,
      action: PayloadAction<{
        key: string
        summary: SearchSummary
        startPage: number
      }>
    ) {
      if (state.key !== action.payload.key) return
      const { summary, startPage } = action.payload
      state.status = "ready"
      state.total = summary.total
      state.pages = summary.pages
      state.cells = summary.cells
      state.cellsTruncated = summary.cellsTruncated
      // Start from where the reviewer is, not from page 1: they searched
      // because of something they were looking at.
      let before = 0
      let start = -1
      for (const entry of summary.pages) {
        if (entry.page >= startPage) {
          start = before
          break
        }
        before += entry.count
      }
      state.current = summary.total === 0 ? -1 : start === -1 ? 0 : start
    },
    searchFailed(state, action: PayloadAction<{ key: string; error: string }>) {
      if (state.key !== action.payload.key) return
      state.status = "error"
      state.error = action.payload.error
      state.total = 0
      state.pages = []
      state.cells = []
      state.current = -1
    },
    pageHitsLoaded(
      state,
      action: PayloadAction<{ key: string; page: number; hits: SearchHit[] }>
    ) {
      if (state.key !== action.payload.key) return
      state.pageHits[action.payload.page] = action.payload.hits
    },
    currentChanged(state, action: PayloadAction<number>) {
      if (state.total === 0) return
      // Wraps, as every find does: Enter on the last hit goes to the first.
      state.current =
        ((action.payload % state.total) + state.total) % state.total
    },
    batchSearchToggled(state, action: PayloadAction<boolean | undefined>) {
      state.batch.open = action.payload ?? !state.batch.open
    },
    batchSearchStarted(state, action: PayloadAction<string>) {
      state.batch.key = action.payload
      state.batch.status = "searching"
      state.batch.error = null
    },
    batchSearchSucceeded(
      state,
      action: PayloadAction<{ key: string; documents: BatchSearchDocument[] }>
    ) {
      if (state.batch.key !== action.payload.key) return
      state.batch.status = "ready"
      state.batch.documents = action.payload.documents
    },
    batchSearchFailed(
      state,
      action: PayloadAction<{ key: string; error: string }>
    ) {
      if (state.batch.key !== action.payload.key) return
      state.batch.status = "error"
      state.batch.error = action.payload.error
      state.batch.documents = []
    },
    searchReset() {
      return initialState
    },
  },
})

export const {
  searchOpened,
  searchClosed,
  queryChanged,
  optionsChanged,
  searchSet,
  searchStarted,
  searchSucceeded,
  searchFailed,
  pageHitsLoaded,
  currentChanged,
  batchSearchToggled,
  batchSearchStarted,
  batchSearchSucceeded,
  batchSearchFailed,
  searchReset,
} = searchSlice.actions

export default searchSlice.reducer

export type HitLocation =
  | { kind: "page"; page: number; index: number }
  | { kind: "cell"; cell: CellHit }

/** Where the n-th hit is: pages first, in order, then cells. */
export function locateHit(
  pages: SearchSummary["pages"],
  cells: CellHit[],
  position: number
): HitLocation | null {
  if (position < 0) return null
  let remaining = position
  for (const entry of pages) {
    if (remaining < entry.count) {
      return { kind: "page", page: entry.page, index: remaining }
    }
    remaining -= entry.count
  }
  const cell = cells[remaining]
  return cell ? { kind: "cell", cell } : null
}

type WithSearch = { search: SearchState }

export const selectCurrentHit = createSelector(
  [
    (state: WithSearch) => state.search.pages,
    (state: WithSearch) => state.search.cells,
    (state: WithSearch) => state.search.current,
  ],
  (pages, cells, current) => locateHit(pages, cells, current)
)

/** A sentence for the counter and for screen readers. */
export function describeSearch(
  search: Pick<SearchState, "status" | "total" | "current" | "error" | "query">
): string {
  if (!search.query) return ""
  if (search.status === "searching") return "Searching…"
  if (search.status === "error") return search.error ?? "Search failed"
  if (search.status !== "ready") return ""
  if (search.total === 0) return "No matches"
  const noun = search.total === 1 ? "match" : "matches"
  return `${search.current + 1} of ${search.total.toLocaleString("en")} ${noun}`
}
