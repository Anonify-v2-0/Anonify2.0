import { createSelector } from "@reduxjs/toolkit"

import { normalizeValue } from "@/lib/documents/shared/text"
import type { RootState } from "@/store/store"
import type { Redaction } from "@/types/redaction"

/**
 * Derived views of the redaction model. Memoized so the canvas and the
 * inspector can both read them on every render without recomputing.
 */

export const selectRedactions = createSelector(
  [(state: RootState) => state.redactions.entities, (state: RootState) => state.redactions.ids],
  (entities, ids) =>
    ids.map((id) => entities[id]).filter((value): value is Redaction => Boolean(value))
)

export const selectFilteredRedactions = createSelector(
  [selectRedactions, (state: RootState) => state.redactions.filters],
  (redactions, filters) =>
    redactions.filter((redaction) => {
      if (filters.status !== "all" && redaction.status !== filters.status) {
        return false
      }
      if (filters.source !== "all" && redaction.source !== filters.source) {
        return false
      }
      if (filters.category !== "all" && redaction.category !== filters.category) {
        return false
      }
      return true
    })
)

export const selectRedactionsForPage = createSelector(
  [selectRedactions, (_state: RootState, page: number) => page],
  (redactions, page) =>
    redactions.filter(
      (redaction) => (redaction.page ?? 1) === page && redaction.status !== "rejected"
    )
)

export const selectCounts = createSelector([selectRedactions], (redactions) => ({
  total: redactions.length,
  suggested: redactions.filter((r) => r.status === "suggested").length,
  accepted: redactions.filter((r) => r.status === "accepted").length,
  rejected: redactions.filter((r) => r.status === "rejected").length,
}))

export const selectCategories = createSelector([selectRedactions], (redactions) => {
  const counts = new Map<string, number>()
  for (const redaction of redactions) {
    counts.set(redaction.category, (counts.get(redaction.category) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
})

/**
 * Groups redactions by the value they cover, which is how a reviewer thinks
 * about them: one decision about "John Smith", not seventeen.
 */
export const selectOccurrenceGroups = createSelector(
  [selectFilteredRedactions],
  (redactions) => {
    const groups = new Map<
      string,
      { key: string; text: string; category: string; members: Redaction[] }
    >()

    for (const redaction of redactions) {
      const text = redaction.text ?? redaction.category
      const key = `${redaction.category}|${normalizeValue(text)}`
      const existing = groups.get(key)
      if (existing) {
        existing.members.push(redaction)
      } else {
        groups.set(key, {
          key,
          text,
          category: redaction.category,
          members: [redaction],
        })
      }
    }

    return [...groups.values()].sort(
      (a, b) =>
        b.members.length - a.members.length ||
        a.text.localeCompare(b.text)
    )
  }
)

export const selectCanUndo = (state: RootState) => state.redactions.past.length > 0
export const selectCanRedo = (state: RootState) => state.redactions.future.length > 0

export const selectSelectedRedaction = createSelector(
  [
    (state: RootState) => state.redactions.entities,
    (state: RootState) => state.redactions.selectedId,
  ],
  (entities, selectedId) => (selectedId ? (entities[selectedId] ?? null) : null)
)
