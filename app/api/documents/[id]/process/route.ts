import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
  rateLimitResponse,
} from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { admitQueued } from "@/lib/documents/admission"
import { startProcessing } from "@/lib/workflows/start-processing"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * A stored handle is either an absolute URL (Vercel Blob) or a `driver:path`
 * key (S3, local filesystem). Both shapes are accepted explicitly rather than
 * relying on `.url()` happening to allow custom schemes.
 */
const storedHandle = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) => /^https?:\/\//.test(value) || /^(local|s3):/.test(value),
    "Not a recognised storage handle"
  )

const bodySchema = z.object({
  blobUrl: storedHandle,
})

/**
 * Hands a finished client upload to the durable pipeline.
 *
 * Starting the run is all this endpoint does — the work itself happens in the
 * workflow, so a slow document does not hold a request open, and a retry of
 * this call resumes the existing run rather than starting a second one.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/process">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const limit = await consumeRateLimit(
      "processing",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) {
      return rateLimitResponse(limit, "processing requests")
    }

    const document = await requireDocument(id, identity?.ownerKey)

    const record = await prisma.document.findUnique({
      where: { id: document.id },
      select: { workflowRunId: true, status: true },
    })

    if (record?.workflowRunId) {
      return jsonResponse({ runId: record.workflowRunId, resumed: true })
    }

    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse("Invalid process request", 400)
    }

    // Queued, not started. Whether it starts now is a question about how much
    // of this owner's work is already in flight, and lib/documents/admission.ts
    // is the one place that answers it — a route that started its own run
    // would be the twentieth concurrent extraction this exists to prevent.
    await prisma.document.update({
      where: { id: document.id },
      data: { uploadBlobKey: parsed.data.blobUrl, status: "queued" },
    })

    await admitQueued(document.userFingerprint, startProcessing)

    const admitted = await prisma.document.findUnique({
      where: { id: document.id },
      select: { workflowRunId: true },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.process",
        documentId: document.id,
        workflowId: admitted?.workflowRunId ?? null,
        // False means it is waiting behind this owner's other documents, which
        // is a normal state rather than a failure: the run that frees a slot
        // admits it, and the cleanup sweep is the backstop.
        started: Boolean(admitted?.workflowRunId),
      })
    )

    return jsonResponse(
      {
        runId: admitted?.workflowRunId ?? null,
        resumed: false,
        queued: !admitted?.workflowRunId,
      },
      202
    )
  } catch (error) {
    return handleRouteError(error, "documents.process")
  }
}
