"use client"

import { useEffect, useRef } from "react"

import { createPoller, documentVisibility, type Poller } from "@/lib/api/poller"

export const POLL_INTERVAL_MS = 4000

/**
 * Calls `poll` every few seconds while `active`, and not at all while the tab
 * is hidden. Coming back to the tab polls once straight away. See
 * `lib/api/poller.ts` for the rules.
 */
export function usePolling(
  poll: () => Promise<void>,
  active: boolean,
  intervalMs = POLL_INTERVAL_MS
) {
  const latest = useRef(poll)
  const poller = useRef<Poller | null>(null)

  useEffect(() => {
    latest.current = poll
  }, [poll])

  useEffect(() => {
    const created = createPoller({
      poll: () => latest.current(),
      intervalMs,
      visibility: documentVisibility(),
    })
    poller.current = created
    return () => {
      created.stop()
      poller.current = null
    }
  }, [intervalMs])

  useEffect(() => {
    poller.current?.setActive(active)
  }, [active, intervalMs])
}
