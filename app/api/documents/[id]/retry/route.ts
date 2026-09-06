
import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  rateLimitResponse,
} from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { failureForCode, isRetryable } from "@/lib/workflows/failure"
import { admitQueued } from "@/lib/documents/admission"
import { startProcessing } from "@/lib/workflows/start-processing"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Runs the pipeline again on a document that failed.
 *
 * A failure was previously terminal in the interface: the screen offered a
 * "Retry analysis" button that did nothing, and the process endpoint refuses to
 * start a second run for a document that already has one. So a document that
 * fell over on a transient error — a provider timeout, a cold worker — stayed
 * failed until it expired, with the user's only option being to upload it again
 * and spend another allowance on it.
 *
 * Retrying is cheap and safe here because the pipeline was built to be resumed:
 * ingest is idempotent, and every later step recomputes from the sealed source
 * rather than from whatever the last attempt left behind.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/documents/[id]/retry">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const limit = await consumeRateLimit(
      "processing",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) return rateLimitResponse(limit, "processing requests")

    const document = await requireDocument(id, identity?.ownerKey)

    const record = await prisma.document.findUnique({
      where: { id: document.id },
      select: {
        status: true,
        errorCode: true,
        sourceBlobKey: true,
        uploadBlobKey: true,
      },
    })
    if (!record) return errorResponse("Document not found", 404)

    if (record.status !== "failed") {
      return errorResponse(
        "This document is not in a failed state.",
        409
      )
    }

    // Ingest reads one or the other; without either there is nothing to run
    // against and a retry would fail the same way, more slowly.
    if (!record.sourceBlobKey && !record.uploadBlobKey) {
      return errorResponse(
        "The uploaded file is no longer available. Upload it again.",
        409
      )
    }

    // Some failures are verdicts, not weather. An unsupported file type does
    // not become supported on the second attempt, and running the pipeline
    // again to reach the same conclusion spends a processing token to tell the
    // user nothing new. The interface hides the button in these cases; this is
    // the check that holds when something calls the endpoint anyway.
    if (!isRetryable(record.errorCode)) {
      const failure = failureForCode(record.errorCode)
      return errorResponse(failure.message, 409, {
        errorCode: failure.code,
        retryable: false,
      })
    }

    // Suggestions from the failed attempt are discarded so a partial run cannot
    // leave duplicates behind. Anything a person touched is kept: an accepted
    // or rejected redaction is a decision, and a retry is not permission to
    // throw those away.
    await prisma.redaction.deleteMany({
      where: { documentId: document.id, source: "ai", status: "suggested" },
    })

    await prisma.document.update({
      where: { id: document.id },
      data: {
        status: "queued",
        error: null,
        errorCode: null,
        workflowRunId: null,
      },
    })

    // Through the same admission as a first attempt. A retry that started its
    // own run would be a way around the concurrency limit, and the obvious
    // moment to press retry is while several other documents are still going.
    await admitQueued(document.userFingerprint, startProcessing)

    const admitted = await prisma.document.findUnique({
      where: { id: document.id },
      select: { workflowRunId: true },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.retry",
        documentId: document.id,
        workflowId: admitted?.workflowRunId ?? null,
        started: Boolean(admitted?.workflowRunId),
      })
    )

    return jsonResponse(
      {
        runId: admitted?.workflowRunId ?? null,
        queued: !admitted?.workflowRunId,
      },
      202
    )
  } catch (error) {
    return handleRouteError(error, "documents.retry")
  }
}
