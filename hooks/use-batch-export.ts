"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { readFailure } from "@/lib/api/errors"
import type { BatchExportView } from "@/lib/documents/batch-exports"
import { decodeBatchExportEvent } from "@/lib/workflows/batch-export-events"
import type { RedactionMethod } from "@/types/redaction"

/**
 * One batch export, watched from anywhere.
 *
 * The run is durable and lives on the server, so this is a reader rather than
 * an owner: it starts one, asks it to stop, and follows it while it works. That
 * is what lets the reviewer close the modal, reload the page or come back later
 * and still see the same run — and what lets the button behind the modal show
 * the progress rather than a shrug.
 *
 * It reads the record once, to find out whether there is anything to watch, and
 * then watches the run's own event stream. It used to ask the database every
 * second and a half instead, which is a query per watcher per tick for a run
 * that spends minutes inside a single document and has nothing new to say for
 * most of them.
 *
 * The record stays the truth. The stream is a progress channel: every event is
 * a whole snapshot, so a missed one is corrected by the next, and when the run
 * ends the record is read once more for the archive link — which is minted per
 * read and deliberately short-lived.
 *
 * One instance per batch, above the button and the dialog both, so there is one
 * connection and one truth rather than two that disagree by a tick.
 */

const RECONNECT_DELAY_MS = 1500
const MAX_RECONNECTS = 6
/** Only after the stream has given up: slow, and just enough to stay honest. */
const FALLBACK_POLL_MS = 5000

const ACTIVE = new Set(["queued", "running"])

export function isActiveExport(state: BatchExportView | null): boolean {
  return state !== null && ACTIVE.has(state.status)
}

/**
 * What the reviewer decided before pressing the button.
 *
 * A batch produces one artifact per document, so there is one method per file
 * rather than a set of variants — `method` covers everything the reviewer did
 * not single out, and `methodByDocument` names the ones they did.
 */
export type BatchStartOptions = {
  method?: RedactionMethod
  methodByDocument?: Record<string, RedactionMethod>
}

export type BatchExportControls = {
  state: BatchExportView | null
  /** True until the first read lands, so nothing renders a wrong idle state. */
  loading: boolean
  starting: boolean
  cancelling: boolean
  start: (options?: BatchStartOptions) => Promise<void>
  cancel: () => Promise<void>
}

export function useBatchExport(batchId: string): BatchExportControls {
  const [state, setState] = useState<BatchExportView | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // Bumped whenever a request of ours changes the run, which is what reconnects
  // the watch below after a start or a stop.
  const [generation, setGeneration] = useState(0)

  const read = useCallback(async (): Promise<BatchExportView | null> => {
    const response = await fetch(`/api/batches/${batchId}/export`, {
      cache: "no-store",
    })
    if (!response.ok) throw new Error("unreadable")
    const payload = (await response.json()) as { export: BatchExportView | null }
    return payload.export
  }, [batchId])

  /**
   * Read once, then follow the run.
   *
   * The stream carries snapshots of the run's own progress; the record is read
   * again only at the end, because that is where the archive link comes from.
   */
  useEffect(() => {
    let cancelled = false
    let attempts = 0
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    /** The last event index actually seen, so a reconnect resumes rather than replays. */
    let lastIndex = -1
    /** Whether the run was still moving the last time anything said so. */
    let running = false

    function schedule(fn: () => void, delay: number) {
      timer = setTimeout(fn, delay)
    }

    async function settle() {
      // The archive link is minted per read and is not on the stream, so the
      // end of a run is the one place a second read earns its keep.
      try {
        const final = await read()
        if (cancelled) return
        running = isActiveExport(final)
        setState(final)
      } catch {
        // The record is durable; the next thing the reviewer does will find it.
      }
    }

    /** Applies one snapshot without waiting for the server to be asked again. */
    function apply(event: ReturnType<typeof decodeBatchExportEvent>) {
      if (!event || cancelled) return

      setState((current) =>
        current
          ? {
              ...current,
              status: event.status,
              total: event.total,
              completed: event.completed,
              exported: event.exported,
              documents: event.documents,
              error: event.error ?? current.error,
            }
          : current
      )
    }

    async function watch() {
      controller = new AbortController()

      try {
        const response = await fetch(
          `/api/batches/${batchId}/export/stream?startIndex=${lastIndex + 1}`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: { accept: "text/event-stream" },
          }
        )

        // 409 means the run is not running any more — it finished between the
        // read and the connection, which is a settle rather than a failure.
        if (response.status === 409) {
          await settle()
          return
        }
        if (!response.ok || !response.body) {
          throw new Error(`stream-failed-${response.status}`)
        }

        attempts = 0
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader()

        let buffer = ""
        let ended = false

        while (!ended) {
          const result = await reader.read()
          if (result.done) break
          buffer += result.value

          // SSE frames are separated by a blank line.
          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            ended = handleFrame(buffer.slice(0, boundary)) || ended
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf("\n\n")
          }
        }

        // No end frame means the connection dropped rather than the run
        // finishing: reconnect and resume from the last event seen.
        if (!cancelled && !ended) throw new Error("stream-closed")
        if (cancelled) return
        await settle()
      } catch (error) {
        if (cancelled || (error as Error).name === "AbortError") return

        attempts += 1
        if (attempts > MAX_RECONNECTS) {
          // The stream is the fast path, not the only one. Falling back to the
          // record keeps a run honest on a connection that will not hold a
          // stream open, rather than leaving a stale count on screen.
          await settle()
          if (!cancelled && running) {
            schedule(() => void watch(), FALLBACK_POLL_MS)
          }
          return
        }

        schedule(() => void watch(), RECONNECT_DELAY_MS * attempts)
      }
    }

    /** Returns true when the stream said it is finished. */
    function handleFrame(frame: string): boolean {
      let id: number | null = null
      let data = ""
      let name = "message"

      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) id = Number(line.slice(3).trim())
        else if (line.startsWith("data:")) data += line.slice(5).trim()
        else if (line.startsWith("event:")) name = line.slice(6).trim()
      }

      if (id !== null && Number.isFinite(id)) lastIndex = id
      if (name === "end") return true

      const event = decodeBatchExportEvent(data)
      apply(event)
      if (event) running = ACTIVE.has(event.status)
      return event?.type === "export.finished"
    }

    async function begin() {
      try {
        const current = await read()
        if (cancelled) return

        running = isActiveExport(current)
        setState(current)
        setLoading(false)

        if (running) await watch()
      } catch {
        if (cancelled) return
        setLoading(false)
      }
    }

    void begin()

    return () => {
      cancelled = true
      controller?.abort()
      if (timer) clearTimeout(timer)
    }
  }, [read, batchId, generation])

  const start = useCallback(async (options: BatchStartOptions = {}) => {
    setStarting(true)
    try {
      const response = await fetch(`/api/batches/${batchId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sanitizeMetadata: true,
          addLabels: false,
          ...options,
        }),
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
      setState(payload.export)
      // Which reconnects the watch onto the run that was just started.
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
      // reconnect below reads what actually happened.
      if (response.ok) {
        const payload = (await response.json()) as {
          export: BatchExportView | null
        }
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
