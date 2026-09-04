"use client"

import { useEffect } from "react"

import { documentStatusChanged } from "@/store/documentSlice"
import { useAppDispatch } from "@/store/hooks"
import { statusChanged } from "@/store/processingSlice"
import type { DocumentSummary } from "@/types/document"
import type { ProcessingStatus } from "@/types/processing"

const TERMINAL = new Set(["ready", "failed", "expired"])
const POLL_INTERVAL_MS = 1500

/**
 * Keeps the workspace in step with server-side processing. Milestone 9 replaces
 * the poll with the SSE stream; the store contract stays the same.
 */
export function useDocumentStatus(documentId: string, initialStatus: string) {
  const dispatch = useAppDispatch()

  useEffect(() => {
    if (TERMINAL.has(initialStatus)) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      try {
        const response = await fetch(`/api/documents/${documentId}`, {
          cache: "no-store",
        })
        if (response.ok) {
          const summary = (await response.json()) as DocumentSummary
          if (cancelled) return
          dispatch(documentStatusChanged(summary.status))
          dispatch(statusChanged(summary.status as ProcessingStatus))
          if (TERMINAL.has(summary.status)) return
        }
      } catch {
        // Transient failure; the next tick retries.
      }

      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS)
    }

    timer = setTimeout(poll, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [dispatch, documentId, initialStatus])
}
