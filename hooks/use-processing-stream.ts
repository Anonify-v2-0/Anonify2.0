"use client"

import { useEffect, useRef } from "react"

import { decodeStreamEvent } from "@/lib/workflows/events"
import {
  documentFailureRecorded,
  documentStatusChanged,
} from "@/store/documentSlice"
import { useAppDispatch } from "@/store/hooks"
import {
  eventReceived,
  processingFailed,
  progressChanged,
  statusChanged,
  suggestionCountChanged,
} from "@/store/processingSlice"
import { randomClientId } from "@/lib/documents/client-ids"
import type { ProcessingStatus } from "@/types/processing"

const TERMINAL = new Set<ProcessingStatus>(["ready", "failed", "expired"])
const RECONNECT_DELAY_MS = 1500
const MAX_RECONNECTS = 10

/**
 * Reads the durable workflow stream for a document.
 *
 * Progress arrives as server-sent events carrying the run's own log, so the UI
 * shows stages completing and suggestions landing as they happen. Each event
 * carries its index; if the connection drops, the next attempt resumes from the
 * one after the last event actually seen rather than replaying the run.
 */
export function useProcessingStream(documentId: string, initialStatus: string) {
  const dispatch = useAppDispatch()
  const lastIndexRef = useRef(-1)

  useEffect(() => {
    if (TERMINAL.has(initialStatus as ProcessingStatus)) return

    let cancelled = false
    let attempts = 0
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    async function connect() {
      controller = new AbortController()
      const startIndex = lastIndexRef.current + 1

      try {
        const response = await fetch(
          `/api/documents/${documentId}/stream?startIndex=${startIndex}`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: { accept: "text/event-stream" },
          }
        )

        if (response.status === 409) {
          // The run has not been registered yet; try again shortly.
          throw new Error("run-not-ready")
        }
        if (!response.ok || !response.body) {
          throw new Error(`stream-failed-${response.status}`)
        }

        attempts = 0
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader()

        let buffer = ""
        let done = false

        while (!done) {
          const result = await reader.read()
          if (result.done) break
          buffer += result.value

          // SSE frames are separated by a blank line.
          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            done = handleFrame(frame) || done
            boundary = buffer.indexOf("\n\n")
          }
        }

        if (!cancelled && !done) {
          // The server closed without an end frame: reconnect and resume.
          throw new Error("stream-closed")
        }
      } catch (error) {
        if (cancelled || (error as Error).name === "AbortError") return
        attempts += 1
        if (attempts > MAX_RECONNECTS) {
          dispatch(processingFailed("Lost contact with the processing run."))
          return
        }
        timer = setTimeout(connect, RECONNECT_DELAY_MS * attempts)
      }
    }

    /** Returns true when the stream signalled that it is finished. */
    function handleFrame(frame: string): boolean {
      let id: number | null = null
      let data = ""
      let name = "message"

      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) id = Number(line.slice(3).trim())
        else if (line.startsWith("data:")) data += line.slice(5).trim()
        else if (line.startsWith("event:")) name = line.slice(6).trim()
      }

      if (id !== null && Number.isFinite(id)) lastIndexRef.current = id
      if (name === "end") return true

      const event = decodeStreamEvent(data)
      if (!event) return false

      dispatch(
        eventReceived({
          id: randomClientId("evt"),
          documentId: event.documentId,
          type: event.type,
          at: event.at,
          payload: event.payload,
        })
      )

      if (event.status) {
        dispatch(statusChanged(event.status))
        dispatch(documentStatusChanged(event.status))
      }
      if (typeof event.progress === "number") {
        dispatch(progressChanged(event.progress))
      }
      if (typeof event.payload?.suggestions === "number") {
        dispatch(suggestionCountChanged(event.payload.suggestions))
      }
      if (event.type === "document.failed") {
        const message = event.message ?? "Processing failed"
        const code = event.payload?.code
        dispatch(processingFailed(message))
        // Carry the reason and its code onto the summary too, so the failure
        // notice can say what happened and decide whether retrying is worth
        // offering, without waiting for a server round trip.
        dispatch(
          documentFailureRecorded({
            message,
            code: typeof code === "string" ? code : null,
          })
        )
      }

      return event.type === "document.ready" || event.type === "document.failed"
    }

    void connect()

    return () => {
      cancelled = true
      controller?.abort()
      if (timer) clearTimeout(timer)
    }
  }, [dispatch, documentId, initialStatus])
}
