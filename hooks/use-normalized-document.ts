"use client"

import { useEffect } from "react"

import { normalizedLoaded } from "@/store/documentSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { isReviewable, type DocumentSummary, type NormalizedDocument } from "@/types/document"

/**
 * Pulls the normalized model once there is one to pull. It is the shared source
 * of geometry and text for the canvas, the inspector and every client-side rule
 * match.
 *
 * This used to wait for `ready`, which meant a document whose analysis failed
 * after extraction never loaded the model it already had — so the canvas sat on
 * its "Preparing this document…" placeholder for a run that had ended.
 */
export function useNormalizedDocument(summary: DocumentSummary) {
  const documentId = summary.id
  const canLoad = isReviewable(summary)
  const dispatch = useAppDispatch()
  const loaded = useAppSelector((state) => state.document.normalized)

  useEffect(() => {
    if (!canLoad || loaded?.documentId === documentId) return

    let cancelled = false

    async function load() {
      try {
        const response = await fetch(`/api/documents/${documentId}/content`, {
          cache: "no-store",
        })
        if (!response.ok) return
        const model = (await response.json()) as NormalizedDocument
        if (!cancelled) dispatch(normalizedLoaded(model))
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
