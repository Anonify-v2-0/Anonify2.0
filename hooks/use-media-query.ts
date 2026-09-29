"use client"

import { useCallback, useSyncExternalStore } from "react"

import { COARSE_POINTER, COMPACT_LAYOUT } from "@/lib/editor/layout"

/**
 * Whether a media query matches, kept current as it changes.
 *
 * The server has no viewport, so it answers `serverValue`; pick the answer
 * that renders nothing surprising before hydration. Anything that must look
 * right on first paint belongs in CSS (the `compact` and `roomy` variants),
 * not here.
 */
export function useMediaQuery(query: string, serverValue = false): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {}
      const list = window.matchMedia(query)
      list.addEventListener("change", notify)
      return () => list.removeEventListener("change", notify)
    },
    [query]
  )

  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(query).matches
        : serverValue,
    () => serverValue
  )
}

/** A finger rather than a cursor; see lib/editor/layout.ts. */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER)
}

/** The phone layout: bottom action bar, sheets; see lib/editor/layout.ts. */
export function useCompactLayout(): boolean {
  return useMediaQuery(COMPACT_LAYOUT)
}
