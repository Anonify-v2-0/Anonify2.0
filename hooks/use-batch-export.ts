"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { readFailure } from "@/lib/api/errors"
import type { BatchExportView } from "@/lib/documents/batch-exports"

/**
 * One batch export, watched from anywhere.
 *
 * The run is durable and lives on the server, so this is a reader rather than
 * an owner: it starts one, asks it to stop, and polls the record while it is
 * going. That is what lets the reviewer close the modal, reload the page or
 * come back later and still see the same run — and what lets the button behind
 * the modal show the progress rather than a shrug.
 *
 * It is used once per batch, above the button and the dialog both, so there is
 * one poller and one truth rather than two that disagree by a tick.
 */

const POLL_INTERVAL_MS = 1500

const ACTIVE = new Set(["queued", "running"])

export function isActiveExport(state: BatchExportView | null): boolean {
  return state !== null && ACTIVE.has(state.status)
}

export type BatchExportControls = {
  state: BatchExportView | null
  /** True until the first read lands, so nothing renders a wrong idle state. */
  loading: boolean
  starting: boolean
  cancelling: boolean
  start: () => Promise<void>
  cancel: () => Promise<void>
}

export function useBatchExport(batchId: string): BatchExportControls {
  const [state, setState] = useState<BatchExportView | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // Bumped whenever a request of ours changes the run, which is what restarts
  // the watch below after a start or a stop.
  const [generation, setGeneration] = useState(0)
  const latest = useRef<BatchExportView | null>(null)

  const read = useCallback(async (): Promise<BatchExportView | null> => {
    const response = await fetch(`/api/batches/${batchId}/export`, {
      cache: "no-store",
    })
    if (!response.ok) throw new Error("unreadable")
    const payload = (await response.json()) as {
      export: BatchExportView | null
    }
    return payload.export
  }, [batchId])

  /**
   * Reads the record, then keeps reading while the run is still moving.
   *
   * The record is the durable one, so a missed tick costs nothing: the next
   * read still reports exactly where the run got to.
   */
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function tick() {
      try {
        const next = await read()
        if (cancelled) return

        latest.current = next
        setState(next)
        setLoading(false)

        if (ACTIVE.has(next?.status ?? "")) {
          timer = setTimeout(tick, POLL_INTERVAL_MS)
        }
      } catch {
        if (cancelled) return
        setLoading(false)
        // A transient failure only earns another try while there was something
        // to watch; otherwise the next action asks again.
        if (isActiveExport(latest.current)) {
          timer = setTimeout(tick, POLL_INTERVAL_MS)
        }
      }
    }

    void tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [read, generation])

  const start = useCallback(async () => {
    setStarting(true)
    try {
      const response = await fetch(`/api/batches/${batchId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sanitizeMetadata: true, addLabels: false }),
      })

      if (!response.ok) {
        const failure = await readFailure(
          response,
          "This batch could not be exported."
        )
        toast.error(failure.message)
        return
      }

      const payload = (await response.json()) as {
        export: BatchExportView | null
      }
      latest.current = payload.export
      setState(payload.export)
      setGeneration((value) => value + 1)
    } catch {
      toast.error("This batch could not be exported.")
    } finally {
      setStarting(false)
    }
  }, [batchId])

  const cancel = useCallback(async () => {
    setCancelling(true)
    try {
      const response = await fetch(`/api/batches/${batchId}/export`, {
        method: "DELETE",
      })

      // A run that finished a moment ago is not an error worth a toast: the
      // reread below shows what actually happened.
      if (response.ok) {
        const payload = (await response.json()) as {
          export: BatchExportView | null
        }
        latest.current = payload.export
        setState(payload.export)
      }
      setGeneration((value) => value + 1)
    } catch {
      toast.error("That export could not be stopped.")
    } finally {
      setCancelling(false)
    }
  }, [batchId])

  return { state, loading, starting, cancelling, start, cancel }
}
