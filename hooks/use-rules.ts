"use client"

import { useCallback, useEffect } from "react"
import { toast } from "sonner"

import { toastFailure } from "@/lib/api/errors"
import type { PatternSpec } from "@/lib/redaction/patterns"
import { reloadRedactions } from "@/hooks/use-redactions"
import { useAppDispatch } from "@/store/hooks"
import { rulesFailed, rulesLoaded, rulesLoading } from "@/store/rulesSlice"
import type { AppDispatch } from "@/store/store"
import type { RuleScope, RuleView } from "@/types/rules"

/**
 * The rules panel's connection to the server.
 *
 * Nothing here is optimistic. A rule reaches documents that are not on screen,
 * so what it did is only knowable by asking, and every change ends by reloading
 * both the rules and this document's redactions from the server.
 */

export async function reloadRules(dispatch: AppDispatch, documentId: string) {
  dispatch(rulesLoading(documentId))
  try {
    const response = await fetch(`/api/documents/${documentId}/rules`, {
      cache: "no-store",
    })
    if (!response.ok) {
      dispatch(rulesFailed())
      return
    }
    const payload = (await response.json()) as { rules: RuleView[] }
    dispatch(rulesLoaded({ documentId, rules: payload.rules }))
  } catch {
    dispatch(rulesFailed())
  }
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`
}

export function useRules(documentId: string, active = true) {
  const dispatch = useAppDispatch()

  useEffect(() => {
    if (active) void reloadRules(dispatch, documentId)
  }, [active, dispatch, documentId])

  const refresh = useCallback(async () => {
    await Promise.all([
      reloadRules(dispatch, documentId),
      reloadRedactions(dispatch, documentId),
    ])
  }, [dispatch, documentId])

  /** Creates a rule. Resolves true when it was written. */
  const create = useCallback(
    async (input: {
      spec: PatternSpec
      category: string
      scope: RuleScope
    }) => {
      try {
        const response = await fetch(`/api/documents/${documentId}/rules`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...input.spec,
            category: input.category,
            scope: input.scope,
          }),
        })
        if (!response.ok) {
          await toastFailure(toast, response, "That rule could not be applied.")
          return false
        }
        const payload = (await response.json()) as {
          redactions: unknown[]
          batch?: { documents: number; redactions: number }
        }
        toast.success(
          payload.batch
            ? `Redacted ${plural(payload.batch.redactions, "occurrence")} across ${plural(payload.batch.documents, "document")}`
            : input.scope === "global"
              ? `Redacted ${plural(payload.redactions.length, "occurrence")} here. Your future uploads get this rule too.`
              : `Redacted ${plural(payload.redactions.length, "occurrence")}`
        )
        await refresh()
        return true
      } catch {
        toast.error("That rule could not be applied.")
        return false
      }
    },
    [documentId, refresh]
  )

  const update = useCallback(
    async (
      rule: RuleView,
      changes: { enabled?: boolean; spec?: PatternSpec; category?: string }
    ) => {
      try {
        const response = await fetch(`/api/documents/${documentId}/rules`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: rule.id, scope: rule.scope, ...changes }),
        })
        if (!response.ok) {
          await toastFailure(toast, response, "That rule could not be changed.")
          return false
        }
        await refresh()
        return true
      } catch {
        toast.error("That rule could not be changed.")
        return false
      }
    },
    [documentId, refresh]
  )

  const remove = useCallback(
    async (rule: RuleView) => {
      try {
        const params = new URLSearchParams({
          ruleId: rule.id,
          scope: rule.scope,
        })
        const response = await fetch(
          `/api/documents/${documentId}/rules?${params}`,
          {
            method: "DELETE",
          }
        )
        if (!response.ok) {
          await toastFailure(toast, response, "That rule could not be removed.")
          return false
        }
        const payload = (await response.json()) as { deleted: number }
        toast.success(
          `Rule removed, with the ${plural(payload.deleted, "redaction")} it made`
        )
        await refresh()
        return true
      } catch {
        toast.error("That rule could not be removed.")
        return false
      }
    },
    [documentId, refresh]
  )

  return { refresh, create, update, remove }
}
