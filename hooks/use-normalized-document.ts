"use client"

import { useEffect } from "react"

import { normalizedLoaded } from "@/store/documentSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import type { NormalizedDocument } from "@/types/document"

/**
 * Pulls the normalized model once the document is ready. It is the shared
 * source of geometry and text for the canvas, the inspector and every
 * client-side rule match.
 */
export function useNormalizedDocument(documentId: string, status: string) {
  const dispatch = useAppDispatch()
  const loaded = useAppSelector((state) => state.document.normalized)

  useEffect(() => {
    if (status !== "ready" || loaded?.documentId === documentId) return

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
  }, [dispatch, documentId, loaded?.documentId, status])

  return loaded?.documentId === documentId ? loaded : null
}
