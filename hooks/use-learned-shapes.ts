"use client"

import { useEffect, useMemo, useRef } from "react"
import { toast } from "sonner"

import { learnShapes, type LearnedShape } from "@/lib/assistant/learn"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectRedactions } from "@/store/selectors"
import { ruleDialogOpened, type RuleDialogRequest } from "@/store/uiSlice"
import type { RuleScope } from "@/types/rules"

/**
 * What Hush has learned from the reviewer's own redactions, and the one-time
 * nudge when it first learns something.
 *
 * Runs in the browser over the redactions already in the store. Nothing is
 * sent anywhere to learn a shape, which is why this works on an instance with
 * no AI provider at all. See lib/assistant/learn.ts.
 */
export function useLearnedShapes(): LearnedShape[] {
  const redactions = useAppSelector(selectRedactions)
  const rules = useAppSelector((state) => state.rules.items)
  const dismissed = useAppSelector((state) => state.ui.hushDismissed)

  return useMemo(
    () =>
      learnShapes(redactions, {
        known: rules.map((rule) => rule.pattern),
      }).filter((shape) => !dismissed.includes(shape.key)),
    [dismissed, redactions, rules]
  )
}

/** The scope Hush suggests for a learned shape, and why in one sentence. */
export function suggestedScope(inBatch: boolean): {
  scope: RuleScope
  reason: string
} {
  return inBatch
    ? {
        scope: "batch",
        reason:
          "documents uploaded together usually share an identifier format, so the rest of the batch likely has more of these.",
      }
    : {
        scope: "document",
        reason:
          "this document was uploaded on its own; widen it to all your uploads if the format is always sensitive to you.",
      }
}

export function learnedRuleRequest(
  shape: LearnedShape,
  inBatch: boolean
): RuleDialogRequest {
  const { scope, reason } = suggestedScope(inBatch)
  return {
    mode: "create",
    spec: shape.spec,
    category: shape.category,
    scope,
    scopeReason: reason,
  }
}

/** A toast, once per shape per visit, when Hush first notices one. */
export function useLearnedShapeNudge(active: boolean) {
  const dispatch = useAppDispatch()
  const shapes = useLearnedShapes()
  const inBatch = useAppSelector(
    (state) => (state.document.summary?.batch?.total ?? 0) > 1
  )
  const announced = useRef(new Set<string>())

  useEffect(() => {
    if (!active) return
    for (const shape of shapes) {
      if (announced.current.has(shape.key)) continue
      announced.current.add(shape.key)
      toast(
        `You've redacted ${shape.examples.length} values like ${shape.display}`,
        {
          description: `Hush can make a rule that finds the rest: ${shape.spec.pattern}`,
          action: {
            label: "Review rule",
            onClick: () =>
              dispatch(ruleDialogOpened(learnedRuleRequest(shape, inBatch))),
          },
        }
      )
    }
  }, [active, dispatch, inBatch, shapes])
}
