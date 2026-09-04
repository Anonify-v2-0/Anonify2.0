"use client"

import { useMemo } from "react"

import { useAppSelector } from "@/store/hooks"
import { selectCounts } from "@/store/selectors"
import type { ProcessingStatus } from "@/types/processing"

/**
 * Announces review state, for people who are not watching the canvas.
 *
 * Suggestions arrive while the pipeline runs and accepting one changes the
 * document silently; both are visible changes with no audible equivalent.
 *
 * The message is derived from current state rather than from a diff held in an
 * effect: a live region announces its content whenever that content changes, so
 * describing where the review stands is both simpler and more useful than
 * narrating each delta — a screen-reader user who arrives late hears the whole
 * position rather than the last thing that happened.
 */

type Counts = ReturnType<typeof selectCounts>

function describe(counts: Counts, status: ProcessingStatus): string {
  if (status === "failed") {
    return "Analysis failed. Your file is safe and can still be redacted by hand."
  }

  if (status !== "ready") {
    return counts.total > 0
      ? `Analyzing. ${counts.total} suggestions found so far.`
      : "Analyzing document."
  }

  if (counts.total === 0) {
    return "Analysis complete. No suggestions found. You can redact by hand."
  }

  const reviewed = counts.accepted + counts.rejected
  if (counts.suggested === 0) {
    return `All ${counts.total} suggestions reviewed. ${counts.accepted} accepted.`
  }

  return `${reviewed} of ${counts.total} suggestions reviewed. ${counts.accepted} accepted, ${counts.suggested} left to review.`
}

export function LiveAnnouncer() {
  const counts = useAppSelector(selectCounts)
  const status = useAppSelector((state) => state.processing.status)

  const message = useMemo(() => describe(counts, status), [counts, status])

  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  )
}
