import { onClosing } from "@/lib/health/state"

/**
 * Server-sent events, and what happens to them when the server goes away.
 *
 * A progress stream is open for as long as its run, minutes at a time, so a
 * replica that waited for them to finish before closing would never close.
 * When the server starts closing (#182) each stream ends itself with a comment
 * frame and no `end` event. The clients read a stream that ends without one as
 * a dropped connection, reconnect, and resume from the last index they saw, on
 * whichever replica answers next.
 */

const encoder = new TextEncoder()

/** The frame a closing server sends last: a comment, which clients ignore. */
export const CLOSING_FRAME = ": server closing, reconnect to resume\n\n"

/**
 * `events`, ended early, without its final frames, if the server starts
 * closing first. The source is cancelled either way the stream ends.
 */
export function endOnServerClose(
  events: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const reader = events.getReader()
  let unsubscribe = () => {}
  let finished = false

  return new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = onClosing(() => {
        if (finished) return
        finished = true
        controller.enqueue(encoder.encode(CLOSING_FRAME))
        controller.close()
        void reader.cancel().catch(() => undefined)
      })
    },
    async pull(controller) {
      if (finished) return
      try {
        const { done, value } = await reader.read()
        if (finished) return
        if (done) {
          finished = true
          unsubscribe()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        if (finished) return
        finished = true
        unsubscribe()
        controller.error(error)
      }
    },
    cancel(reason) {
      finished = true
      unsubscribe()
      return reader.cancel(reason)
    },
  })
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const
