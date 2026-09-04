import { getRun } from "workflow/api"

import { errorResponse, handleRouteError } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Server-sent events carrying the workflow run's progress.
 *
 * The run's stream is durable and indexed, so a client that drops can reconnect
 * with the index of the last event it saw and pick up exactly where it left off
 * rather than replaying the whole run or missing the middle of it.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/documents/[id]/stream">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)

    const record = await prisma.document.findUnique({
      where: { id: document.id },
      select: { workflowRunId: true },
    })

    if (!record?.workflowRunId) {
      return errorResponse("No processing run for this document", 409)
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
        // The workflow writes newline-delimited JSON; one line is one event.
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
    return handleRouteError(error, "documents.stream")
  }
}
