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

/** Sent on a stream that has been quiet; a comment, which clients ignore. */
export const KEEPALIVE_FRAME = ": keep-alive\n\n"

/**
 * How long a stream may go without a byte before a keep-alive is sent (#244).
 * A step can run for minutes between events, and proxies commonly close a
 * connection idle for 60 seconds (the AWS ALB's default, Fly's proxy, many
 * ingress controllers). The client would reconnect and resume, but every
 * reconnect is a request and a database read; a comment every 15 seconds is
 * neither.
 */
export const KEEPALIVE_MS = 15_000

/**
 * `events`, ended early, without its final frames, if the server starts
 * closing first, and kept alive with comments while it is quiet. The source
 * is cancelled either way the stream ends.
 *
 * Every chunk the routes enqueue is a whole frame, so a comment sent between
 * two of them never splits one.
 */
export function endOnServerClose(
  events: ReadableStream<Uint8Array>,
  { keepAliveMs = KEEPALIVE_MS }: { keepAliveMs?: number } = {}
): ReadableStream<Uint8Array> {
  const reader = events.getReader()
  let unsubscribe = () => {}
  let finished = false
  let lastSent = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined

  const finish = () => {
    finished = true
    clearInterval(timer)
    unsubscribe()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = onClosing(() => {
        if (finished) return
        finish()
        controller.enqueue(encoder.encode(CLOSING_FRAME))
        controller.close()
        void reader.cancel().catch(() => undefined)
      })
      if (keepAliveMs > 0) {
        timer = setInterval(
          () => {
            if (finished || Date.now() - lastSent < keepAliveMs) return
            lastSent = Date.now()
            controller.enqueue(encoder.encode(KEEPALIVE_FRAME))
          },
          Math.max(1, Math.floor(keepAliveMs / 3))
        )
        // A stream nobody reads any more must not keep the process alive.
        timer.unref?.()
      }
    },
    async pull(controller) {
      if (finished) return
      try {
        const { done, value } = await reader.read()
        if (finished) return
        if (done) {
          finish()
          controller.close()
          return
        }
        lastSent = Date.now()
        controller.enqueue(value)
      } catch (error) {
        if (finished) return
        finish()
        controller.error(error)
      }
    },
    cancel(reason) {
      finish()
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
