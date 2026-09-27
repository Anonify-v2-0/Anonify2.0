"use client"

import { useEffect } from "react"

import { normalizedLoaded, pageLoaded } from "@/store/documentSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import type { AppDispatch } from "@/store/store"
import {
  isReviewable,
  type DocumentSummary,
  type NormalizedOutline,
  type NormalizedPage,
} from "@/types/document"

/**
 * Pulls the model's outline once there is one to pull: everything the model
 * carries except its pages, and which pages exist. Pages come after, one at a
 * time, through `useNormalizedPage` — a long document costs the browser the
 * pages being looked at rather than all of them.
 *
 * This used to wait for `ready`, which meant a document whose analysis failed
 * after extraction never loaded the model it already had — so the canvas sat on
 * its "Preparing this document…" placeholder for a run that had ended.
 */
export function useNormalizedDocument(
  summary: DocumentSummary
): NormalizedOutline | null {
  const documentId = summary.id
  const canLoad = isReviewable(summary)
  const dispatch = useAppDispatch()
  const loaded = useAppSelector((state) => state.document.normalized)

  useEffect(() => {
    if (!canLoad || loaded?.documentId === documentId) return

    let cancelled = false

    async function load() {
      try {
        const response = await fetch(
          `/api/documents/${documentId}/content?view=outline`,
          { cache: "no-store" }
        )
        if (!response.ok) return
        const outline = (await response.json()) as NormalizedOutline
        if (!cancelled) dispatch(normalizedLoaded(outline))
      } catch {
        // The canvas shows its own empty state; a retry happens on next render.
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [canLoad, dispatch, documentId, loaded?.documentId])

  return loaded?.documentId === documentId ? loaded : null
}

/**
 * Requests in flight, so the canvas, a thumbnail and a prefetch asking for the
 * same page at once make one request between them.
 */
const inFlight = new Map<string, Promise<void>>()

/** Fetches one page into the store, unless it is already on its way. */
export function fetchPage(
  dispatch: AppDispatch,
  documentId: string,
  pageNumber: number
): Promise<void> {
  const key = `${documentId}:${pageNumber}`
  const pending = inFlight.get(key)
  if (pending) return pending

  const request = (async () => {
    try {
      const response = await fetch(
        `/api/documents/${documentId}/content?page=${pageNumber}`,
        { cache: "no-store" }
      )
      if (!response.ok) return
      const page = (await response.json()) as NormalizedPage
      dispatch(pageLoaded({ documentId, page }))
    } catch {
      // Whoever asked shows its own empty state, and asks again when it is
      // next rendered with this page in view.
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, request)
  return request
}

/**
 * One page of the open document, fetched when it is first wanted.
 *
 * Null until it arrives, and for a page the document does not have. `enabled`
 * lets a thumbnail hold off until it is scrolled into view.
 */
export function useNormalizedPage(
  documentId: string,
  pageNumber: number | undefined,
  enabled = true
): NormalizedPage | null {
  const dispatch = useAppDispatch()
  const outline = useAppSelector((state) => state.document.normalized)
  const exists =
    pageNumber !== undefined &&
    outline?.documentId === documentId &&
    outline.pageNumbers.includes(pageNumber)
  const page = useAppSelector((state) =>
    exists && pageNumber !== undefined
      ? (state.document.pages[pageNumber] ?? null)
      : null
  )

  useEffect(() => {
    if (!enabled || !exists || page || pageNumber === undefined) return
    void fetchPage(dispatch, documentId, pageNumber)
  }, [dispatch, documentId, enabled, exists, page, pageNumber])

  return page
}

/**
 * Starts fetching the pages next to the one on screen, so paging through a
 * document does not wait on a request at every step.
 */
export function usePrefetchPages(
  documentId: string,
  pageNumbers: (number | undefined)[]
): void {
  const dispatch = useAppDispatch()
  const outline = useAppSelector((state) => state.document.normalized)
  const cached = useAppSelector((state) => state.document.pages)
  const wanted = pageNumbers
    .filter(
      (number): number is number =>
        number !== undefined &&
        outline?.documentId === documentId &&
        outline.pageNumbers.includes(number) &&
        !cached[number]
    )
    .join(",")

  useEffect(() => {
    if (!wanted) return
    for (const number of wanted.split(",")) {
      void fetchPage(dispatch, documentId, Number(number))
    }
  }, [dispatch, documentId, wanted])
}
