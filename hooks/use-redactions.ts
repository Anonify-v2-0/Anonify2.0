"use client"

import { useCallback, useEffect } from "react"
import { toast } from "sonner"

import { toastFailure } from "@/lib/api/errors"
import { randomClientId } from "@/lib/documents/client-ids"
import { useAppDispatch, useAppSelector, useAppStore } from "@/store/hooks"
import {
  redactionAdded,
  redactionRemoved,
  redactionsAdded,
  redactionsReplaced,
  redactionStatusSet,
  redactionMethodSet,
  redone,
  ruleAdded,
  undone,
} from "@/store/redactionSlice"
import { selectRedactions } from "@/store/selectors"
import type {
  Redaction,
  RedactionMethod,
  RedactionStatus,
} from "@/types/redaction"

/**
 * How far a rule reaches. `batch` records the decision on the batch itself, so
 * it also applies to documents that finish processing after it was made.
 */
export type RuleScope = "document" | "batch"

/**
 * The editor's connection to the redaction record.
 *
 * Changes are applied locally first so the canvas responds immediately, then
 * persisted. A write that fails is reported and reloaded from the server rather
 * than left to drift: the export reads the server's copy, so the two must not
 * disagree about what the user accepted.
 */
export function useRedactions(documentId: string, active: boolean) {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const redactions = useAppSelector(selectRedactions)

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/documents/${documentId}/redactions`, {
        cache: "no-store",
      })
      if (!response.ok) return
      const payload = (await response.json()) as { redactions: Redaction[] }
      dispatch(redactionsReplaced(payload.redactions))
    } catch {
      // The inspector shows what it has; the next action retries.
    }
  }, [dispatch, documentId])

  useEffect(() => {
    // Also true for a document whose analysis failed after extraction: a run
    // that stopped partway can still have persisted suggestions, and manual
    // redaction has to start from whatever is actually on the server.
    if (!active) return
    void reload()
  }, [active, reload])

  const setStatus = useCallback(
    async (ids: string[], next: RedactionStatus) => {
      if (ids.length === 0) return
      dispatch(redactionStatusSet({ ids, status: next }))

      try {
        const response = await fetch(
          `/api/documents/${documentId}/redactions`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids, status: next }),
          }
        )
        if (!response.ok) {
          await toastFailure(toast, response, "That change could not be saved.")
          dispatch(undone())
          void reload()
        }
      } catch {
        toast.error("That change could not be saved.")
        dispatch(undone())
        void reload()
      }
    },
    [dispatch, documentId, reload]
  )

  const create = useCallback(
    async (input: Omit<Redaction, "id" | "documentId">) => {
      const optimistic: Redaction = {
        ...input,
        id: randomClientId("red"),
        documentId,
      }
      dispatch(redactionAdded(optimistic))

      try {
        const response = await fetch(
          `/api/documents/${documentId}/redactions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }
        )
        if (!response.ok) {
          await toastFailure(toast, response, "That redaction could not be saved.")
          dispatch(redactionRemoved(optimistic.id))
          return null
        }

        // Adopt the server's id so later edits address the same row.
        const payload = (await response.json()) as { redaction: Redaction }
        dispatch(redactionRemoved(optimistic.id))
        dispatch(redactionAdded(payload.redaction))
        return payload.redaction
      } catch {
        toast.error("That redaction could not be saved.")
        dispatch(redactionRemoved(optimistic.id))
        return null
      }
    },
    [dispatch, documentId]
  )

  const remove = useCallback(
    async (id: string) => {
      dispatch(redactionRemoved(id))
      try {
        await fetch(
          `/api/documents/${documentId}/redactions?redactionId=${encodeURIComponent(id)}`,
          { method: "DELETE" }
        )
      } catch {
        void reload()
      }
    },
    [dispatch, documentId, reload]
  )

  /**
   * Applies a value everywhere it appears. The occurrences are found on the
   * server by searching the normalized document — no second model call, and no
   * risk of a different answer for the same string.
   */
  const applyGlobalRule = useCallback(
    async (pattern: string, category: string, scope: RuleScope = "document") => {
      try {
        const response = await fetch(`/api/documents/${documentId}/rules`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pattern, category, scope }),
        })
        if (!response.ok) {
          await toastFailure(toast, response, "That rule could not be applied.")
          return
        }

        const payload = (await response.json()) as {
          rule: { id: string; pattern: string; category: string; enabled: boolean }
          redactions: Redaction[]
          batch?: { documents: number; redactions: number }
        }

        dispatch(
          ruleAdded({
            ...payload.rule,
            documentId,
            normalizedPattern: pattern.trim().toLowerCase(),
          })
        )
        dispatch(redactionsAdded(payload.redactions))

        // A batch rule's interesting number is not the one on screen: the
        // reviewer needs to know it reached the documents they are not looking
        // at, or the decision they just took is invisible until they open one.
        toast.success(
          payload.batch
            ? `Redacted ${payload.batch.redactions} ${
                payload.batch.redactions === 1 ? "occurrence" : "occurrences"
              } across ${payload.batch.documents} ${
                payload.batch.documents === 1 ? "document" : "documents"
              }`
            : payload.redactions.length === 1
              ? "Redacted 1 occurrence"
              : `Redacted ${payload.redactions.length} occurrences`
        )
        return payload.redactions.length
      } catch {
        toast.error("That rule could not be applied.")
        return 0
      }
    },
    [dispatch, documentId]
  )

  const accept = useCallback(
    (ids: string[]) => setStatus(ids, "accepted"),
    [setStatus]
  )

  /**
   * Chooses what accepting these will do to the bytes.
   *
   * Not an accept. A reviewer weighing up whether to redact a name can decide
   * it should be tokenised if they do, and collapsing the two would make
   * picking a method an irreversible decision to redact.
   */
  const setMethod = useCallback(
    async (ids: string[], method: RedactionMethod) => {
      if (ids.length === 0) return
      dispatch(redactionMethodSet({ ids, method }))

      try {
        const response = await fetch(
          `/api/documents/${documentId}/redactions`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids, method }),
          }
        )
        if (!response.ok) {
          await toastFailure(toast, response, "That change could not be saved.")
          dispatch(undone())
          void reload()
        }
      } catch {
        toast.error("That change could not be saved.")
        dispatch(undone())
        void reload()
      }
    },
    [dispatch, documentId, reload]
  )
  const reject = useCallback(
    (ids: string[]) => setStatus(ids, "rejected"),
    [setStatus]
  )

  /**
   * Pushes the post-undo statuses to the server. The state is read from the
   * store rather than the render's snapshot, because the dispatch that has just
   * run is exactly the change being synced.
   */
  const syncStatuses = useCallback(async () => {
    const state = store.getState().redactions
    const grouped = new Map<RedactionStatus, string[]>()

    for (const id of state.ids) {
      const redaction = state.entities[id]
      if (!redaction) continue
      const list = grouped.get(redaction.status) ?? []
      list.push(id)
      grouped.set(redaction.status, list)
    }

    await Promise.all(
      [...grouped.entries()].map(([next, ids]) =>
        fetch(`/api/documents/${documentId}/redactions`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids, status: next }),
        }).catch(() => undefined)
      )
    )
  }, [documentId, store])

  const undo = useCallback(() => {
    dispatch(undone())
    // The canvas is what the user just saw change; the server has to agree with
    // it, because the export reads the server's copy.
    void syncStatuses()
  }, [dispatch, syncStatuses])

  const redo = useCallback(() => {
    dispatch(redone())
    void syncStatuses()
  }, [dispatch, syncStatuses])

  return {
    redactions,
    reload,
    accept,
    reject,
    setMethod,
    create,
    remove,
    applyGlobalRule,
    undo,
    redo,
  }
}
