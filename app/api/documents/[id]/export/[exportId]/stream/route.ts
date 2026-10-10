import { getRun } from "workflow/api"

import { errorResponse, handleRouteError } from "@/lib/api/http"
import { endOnServerClose, SSE_HEADERS } from "@/lib/api/sse"
import { findDocumentExport } from "@/lib/documents/document-exports"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"

export const runtime = "nodejs"
// See app/api/documents/[id]/stream/route.ts: 300s is the Hobby ceiling, and
// this stream is resumable, so being cut at it costs a reconnect.
export const maxDuration = 300

const ACTIVE = new Set(["queued", "running"])

/**
 * Server-sent events carrying a background export's progress (#187): a
 * stage, a variant and pages drawn, resumable from the last index seen. A
 * 409 means the export is not running any more; read its status instead.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/documents/[id]/export/[exportId]/stream">
) {
  try {
    const { id, exportId } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)
    const record = await findDocumentExport(document.id, exportId)
    if (!record) return errorResponse("Export not found", 404)
    if (!ACTIVE.has(record.status) || !record.workflowRunId) {
      return errorResponse("That export is no longer running", 409)
    }

    const url = new URL(request.url)
    const requested = Number(url.searchParams.get("startIndex"))
    const startIndex = Number.isFinite(requested) ? requested : 0

    const readable = getRun(record.workflowRunId).getReadable<string>({
      startIndex,
    })
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

    // Ended early, without the end frame, if this replica starts shutting
    // down: the client then resumes from its last index elsewhere (#182).
    return new Response(endOnServerClose(readable.pipeThrough(sse)), {
      headers: SSE_HEADERS,
    })
  } catch (error) {
    return handleRouteError(error, "documents.export.stream")
  }
}
