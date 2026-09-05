import { getRun } from "workflow/api"

import { errorResponse, handleRouteError } from "@/lib/api/http"
import { latestBatchExport } from "@/lib/documents/batch-exports"
import { requireBatch } from "@/lib/documents/batches"
import { peekIdentity } from "@/lib/security/fingerprint"

export const runtime = "nodejs"
export const maxDuration = 900

const ACTIVE = new Set(["queued", "running"])

/**
 * The batch export's progress, as server-sent events.
 *
 * The run writes a snapshot every time a document settles, and this relays
 * them. It replaces a client that asked the database every second and a half
 * whether anything had changed — which was one query per watcher per tick, for
 * a run that spends most of its time inside a single document and has nothing
 * new to say.
 *
 * The run's stream is durable and indexed, so a client that drops reconnects
 * with the index of the last event it saw and picks up exactly there rather
 * than replaying the run or missing the middle of it.
 *
 * A run that has already finished is a 409 rather than an empty stream: the
 * client has a record it can read once, and holding a connection open for
 * something that will never speak is worse than saying so.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/batches/[id]/export/stream">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const batch = await requireBatch(id, identity?.ownerKey)

    const record = await latestBatchExport(batch.id)
    if (!record) {
      return errorResponse("This batch has no export to watch", 409)
    }
    if (!ACTIVE.has(record.status) || !record.workflowRunId) {
      return errorResponse("That export is no longer running", 409)
    }

    const url = new URL(request.url)
    const requested = Number(url.searchParams.get("startIndex"))
    const startIndex = Number.isFinite(requested) ? requested : 0

    const run = getRun(record.workflowRunId)
    const readable = run.getReadable<string>({ startIndex })

    const encoder = new TextEncoder()
    let index = startIndex

    const sse = new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        // The run writes newline-delimited JSON; one line is one event.
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue
          controller.enqueue(encoder.encode(`id: ${index}\ndata: ${line}\n\n`))
          index += 1
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"))
      },
    })

    return new Response(readable.pipeThrough(sse), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    })
  } catch (error) {
    return handleRouteError(error, "batches.export.stream")
  }
}
