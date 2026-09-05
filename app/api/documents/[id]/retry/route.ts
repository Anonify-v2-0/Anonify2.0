import { start } from "workflow/api"

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
import { processDocument } from "@/lib/workflows/process-document"

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

    const run = await start(processDocument, [document.id])

    await prisma.document.update({
      where: { id: document.id },
      data: { workflowRunId: run.runId },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.retry",
        documentId: document.id,
        workflowId: run.runId,
      })
    )

    return jsonResponse({ runId: run.runId }, 202)
  } catch (error) {
    return handleRouteError(error, "documents.retry")
  }
}
