import { z } from "zod"

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { requireBatch } from "@/lib/documents/batches"
import {
  collectBatchExport,
  EmptyBatchError,
  runBatchExport,
} from "@/lib/redaction/batch-export"
import { peekIdentity } from "@/lib/security/fingerprint"

export const runtime = "nodejs"
export const maxDuration = 300

const optionsSchema = z.object({
  addLabels: z.boolean().default(false),
  sanitizeMetadata: z.boolean().default(true),
  imageStyle: z.enum(["solid", "blur", "pixelate"]).default("solid"),
})

const NDJSON = "application/x-ndjson"

/**
 * Exports every document in the batch.
 *
 * The run itself lives in `lib/redaction/batch-export.ts`; this route decides
 * how to answer. A client that asks for `application/x-ndjson` is streamed one
 * JSON line per event as the work happens — a batch is minutes of work, and a
 * progress bar that can name the document it is on is the difference between
 * waiting and wondering. Anything else gets the single JSON reply this route
 * has always returned.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/batches/[id]/export">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const batch = await requireBatch(id, identity?.ownerKey)
    const options = optionsSchema.parse(await request.json().catch(() => ({})))
    const networkKey = identity?.networkKey ?? "anonymous"

    if (request.headers.get("accept")?.includes(NDJSON)) {
      return streamed({ batch, options, networkKey })
    }

    const result = await collectBatchExport({ batch, options, networkKey })

    // Nothing exported is not a partial success: there is no archive behind the
    // token, so the status says so and the skip reasons explain why.
    return jsonResponse(result, result.exported.length === 0 ? 409 : 200)
  } catch (error) {
    if (error instanceof EmptyBatchError) {
      return errorResponse("This batch has no documents left", 409)
    }
    return handleRouteError(error, "batches.export")
  }
}

/**
 * The same run, reported as it goes.
 *
 * The headers matter as much as the body: a proxy that buffers this delivers
 * every event at once at the end, which is exactly the spinner the stream
 * exists to replace.
 *
 * A client that goes away stops the run. Breaking out of the loop returns the
 * generator, so the batch does not spend another document's export allowance
 * producing an archive nobody is waiting for — and the documents already
 * exported keep their artifacts, which is what makes coming back cheap.
 */
function streamed(input: Parameters<typeof runBatchExport>[0]): Response {
  const encoder = new TextEncoder()
  let gone = false

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        if (gone) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          // The consumer disconnected between the check and the write.
          gone = true
        }
      }

      try {
        for await (const event of runBatchExport(input)) {
          if (gone) break
          send(event)
        }
      } catch (error) {
        // The response has already begun, so a failure cannot become a status
        // code. It goes down the stream as a final event the client renders.
        console.error(
          JSON.stringify({
            level: "error",
            context: "batches.export.stream",
            errorCategory:
              error instanceof EmptyBatchError ? "empty-batch" : "unexpected",
          })
        )
        send({
          type: "error",
          message:
            error instanceof EmptyBatchError
              ? "This batch has no documents left."
              : "The batch export could not be completed.",
        })
      } finally {
        try {
          controller.close()
        } catch {
          // Already closed by the cancel above; nothing to do.
        }
      }
    },
    cancel() {
      gone = true
    },
  })

  return new Response(body, {
    headers: {
      "content-type": `${NDJSON}; charset=utf-8`,
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  })
}
