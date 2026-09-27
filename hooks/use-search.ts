"use client"

import { useCallback, useEffect, useRef } from "react"

import { readFailure } from "@/lib/api/errors"
import { patternProblem } from "@/lib/redaction/patterns"
import type {
  BatchSearchDocument,
  SearchHit,
  SearchSummary,
} from "@/lib/redaction/search"
import { pageChanged, sheetChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector, useAppStore } from "@/store/hooks"
import {
  batchSearchFailed,
  batchSearchStarted,
  batchSearchSucceeded,
  currentChanged,
  pageHitsLoaded,
  searchFailed,
  searchKey,
  searchStarted,
  searchSucceeded,
  selectCurrentHit,
  specOfSearch,
} from "@/store/searchSlice"

/** Long enough to skip most keystrokes, short enough to feel like typing. */
const DEBOUNCE_MS = 250

/**
 * Runs the search the bar describes, against the server.
 *
 * Three requests, each only when it is needed: where every hit is (once per
 * question), the hits on the page being shown (once per page per question),
 * and — when the reviewer widened it — a count per document in the batch.
 * Moving to a hit moves the page, or the sheet, to where it is.
 */
export function useSearch(
  documentId: string,
  batchId: string | null,
  active: boolean
) {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const search = useAppSelector((state) => state.search)
  const currentPage = useAppSelector((state) => state.editor.currentPage)
  const activeSheet = useAppSelector((state) => state.editor.activeSheet)
  const hit = useAppSelector(selectCurrentHit)

  const spec = specOfSearch(search)
  const key = search.open && search.query ? searchKey(spec) : null

  // Where every hit is, once per question.
  useEffect(() => {
    if (!active || !key) return
    const problem = patternProblem(spec)
    if (problem) {
      dispatch(searchStarted(key))
      dispatch(searchFailed({ key, error: problem }))
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      dispatch(searchStarted(key))
      try {
        const response = await fetch(`/api/documents/${documentId}/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ spec }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const failure = await readFailure(response, "Search failed.")
          dispatch(searchFailed({ key, error: failure.message }))
          return
        }
        const summary = (await response.json()) as SearchSummary
        dispatch(
          searchSucceeded({
            key,
            summary,
            startPage: store.getState().editor.currentPage,
          })
        )
      } catch (error) {
        if ((error as Error).name === "AbortError") return
        dispatch(
          searchFailed({ key, error: "Search failed. Check your connection." })
        )
      }
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // `spec` is derived from `key`, which is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, dispatch, documentId, key, store])

  // The hits on the page being shown, which is what gets highlighted.
  const hasHitsHere = search.pages.some((entry) => entry.page === currentPage)
  const loadedHere = search.pageHits[currentPage] !== undefined
  useEffect(() => {
    if (!active || !key || search.status !== "ready") return
    if (search.key !== key || !hasHitsHere || loadedHere) return

    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(`/api/documents/${documentId}/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ spec, page: currentPage }),
          signal: controller.signal,
        })
        if (!response.ok) return
        const payload = (await response.json()) as { hits: SearchHit[] }
        dispatch(pageHitsLoaded({ key, page: currentPage, hits: payload.hits }))
      } catch {
        // The counter still stands; the highlights come with the next page turn.
      }
    })()
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    currentPage,
    dispatch,
    documentId,
    hasHitsHere,
    key,
    loadedHere,
    search.key,
    search.status,
  ])

  // Moving to the current hit. Only when it changes, so a reviewer who pages
  // away from it is not dragged back.
  const lastMoved = useRef<string | null>(null)
  const position = search.current
  useEffect(() => {
    if (!hit || !key) return
    const identity = `${key}#${position}`
    if (lastMoved.current === identity) return
    lastMoved.current = identity

    if (
      hit.kind === "page" &&
      hit.page !== store.getState().editor.currentPage
    ) {
      dispatch(pageChanged(hit.page))
    }
    if (hit.kind === "cell" && hit.cell.worksheet !== activeSheet) {
      dispatch(sheetChanged(hit.cell.worksheet))
    }
  }, [activeSheet, dispatch, hit, key, position, store])

  // Counts across the batch, when the reviewer asked for them.
  useEffect(() => {
    if (!active || !key || !batchId || !search.batch.open) return
    // Read from the store rather than depended on: starting the request sets
    // it, and an effect that re-ran on that would abort its own request.
    if (search.status !== "ready" || store.getState().search.batch.key === key)
      return

    const controller = new AbortController()
    dispatch(batchSearchStarted(key))
    void (async () => {
      try {
        const response = await fetch(`/api/batches/${batchId}/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ spec }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const failure = await readFailure(
            response,
            "The batch could not be searched."
          )
          dispatch(batchSearchFailed({ key, error: failure.message }))
          return
        }
        const payload = (await response.json()) as {
          documents: BatchSearchDocument[]
        }
        dispatch(batchSearchSucceeded({ key, documents: payload.documents }))
      } catch (error) {
        if ((error as Error).name === "AbortError") return
        dispatch(
          batchSearchFailed({ key, error: "The batch could not be searched." })
        )
      }
    })()
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, batchId, dispatch, key, search.batch.open, search.status, store])

  const next = useCallback(
    () => dispatch(currentChanged(store.getState().search.current + 1)),
    [dispatch, store]
  )
  const previous = useCallback(
    () => dispatch(currentChanged(store.getState().search.current - 1)),
    [dispatch, store]
  )

  return { next, previous }
}
