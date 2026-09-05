import { getRun, start } from "workflow/api"
import { z } from "zod"

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import {
  activeBatchExport,
  latestBatchExport,
  settlePending,
  toView,
  type BatchExportRecord,
} from "@/lib/documents/batch-exports"
import { requireBatch, type OwnedBatch } from "@/lib/documents/batches"
import { newBatchExportId } from "@/lib/documents/ids"
import { listBatchDocuments } from "@/lib/documents/listing"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { createBatchToken } from "@/lib/security/signed-url"
import { exportBatch } from "@/lib/workflows/export-batch"

export const runtime = "nodejs"

const optionsSchema = z.object({
  addLabels: z.boolean().default(false),
  sanitizeMetadata: z.boolean().default(true),
  imageStyle: z.enum(["solid", "blur", "pixelate"]).default("solid"),
})

/**
 * Batch exports, as a resource rather than an operation.
 *
 * Starting one is all POST does: the work happens in a durable run, so a batch
 * of a dozen documents does not depend on a request staying open for minutes or
 * on the reviewer leaving a modal on screen. GET reports where that run has got
 * to — the progress lives on the row, so it survives a closed tab, a reload and
 * the recycling of whichever function happened to start it. DELETE asks it to
 * stop.
 */

/**
 * The archive link, minted at read time rather than stored.
 *
 * A download token is short-lived on purpose. Writing one into the row would
 * mean handing out a link that expired minutes after the run finished, which is
 * exactly the case durability was supposed to fix: coming back later and still
 * being able to fetch the result.
 *
 * A stopped run gets one too, when it exported anything. Those documents were
 * redacted, verified and sealed before the reviewer said stop, and withholding
 * them would make cancelling cost more than it saved.
 */
function withDownloadUrl(record: BatchExportRecord, batch: OwnedBatch) {
  const deliverable =
    record.status === "ready" ||
    (record.status === "cancelled" && record.exported > 0)

  const url = deliverable
    ? `/api/batches/${batch.id}/download?token=${createBatchToken({
        batchId: batch.id,
        ownerKey: batch.userFingerprint,
      })}`
    : null

  return toView(record, url)
}

export async function GET(
  _request: Request,
  context: RouteContext<"/api/batches/[id]/export">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const batch = await requireBatch(id, identity?.ownerKey)

    const record = await latestBatchExport(batch.id)
    return jsonResponse({
      export: record ? withDownloadUrl(record, batch) : null,
    })
  } catch (error) {
    return handleRouteError(error, "batches.export.status")
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/batches/[id]/export">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const batch = await requireBatch(id, identity?.ownerKey)

    // A second click while one is already going joins it rather than starting a
    // rival run over the same documents.
    const running = await activeBatchExport(batch.id)
    if (running) {
      return jsonResponse({ export: withDownloadUrl(running, batch) })
    }

    const documents = await listBatchDocuments(batch.id)
    if (documents.length === 0) {
      return errorResponse("This batch has no documents left", 409)
    }

    // One token to start a run; the per-document export allowance is charged
    // inside it, one document at a time, exactly as a single export would be.
    const limit = await consumeRateLimit(
      "processing",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) {
      return errorResponse(
        "Too many export runs. Try again in a moment.",
        429,
        { rateLimited: true }
      )
    }

    const options = optionsSchema.parse(await request.json().catch(() => ({})))
    const exportId = newBatchExportId()

    await prisma.batchExport.create({
      data: {
        id: exportId,
        batchId: batch.id,
        status: "queued",
        total: documents.length,
        options,
        networkKey: identity?.networkKey ?? "anonymous",
      },
    })

    const run = await start(exportBatch, [exportId])
    await prisma.batchExport.update({
      where: { id: exportId },
      data: { workflowRunId: run.runId },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "batches.export",
        batchId: batch.id,
        exportId,
        workflowId: run.runId,
        documents: documents.length,
      })
    )

    const created = await latestBatchExport(batch.id)
    return jsonResponse(
      { export: created ? withDownloadUrl(created, batch) : null },
      202
    )
  } catch (error) {
    return handleRouteError(error, "batches.export")
  }
}

/** Stops a run in progress. */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/batches/[id]/export">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const batch = await requireBatch(id, identity?.ownerKey)

    const running = await activeBatchExport(batch.id)
    if (!running) {
      return errorResponse("There is no export running for this batch", 409)
    }

    // The flag first, so a step that is between documents stops on its own and
    // records why. The document being redacted right now is finished and kept:
    // it has been paid for in allowance and in time, and throwing it away is
    // not what the reviewer asked for.
    await prisma.batchExport.updateMany({
      where: { id: running.id, status: { in: ["queued", "running"] } },
      data: { cancelRequested: true },
    })

    // Then the run itself, so a step that has hung cannot keep the export alive
    // — and so nothing carries on spending the export allowance on documents
    // the reviewer has said they do not want.
    if (running.workflowRunId) {
      try {
        await getRun(running.workflowRunId).cancel()
      } catch {
        // Already finished or already cancelled: the row below is the record
        // either way.
      }
    }

    // Cancelling the run means its own closing steps will not get to run, so
    // the final state is written here instead.
    await settlePending(running.id, "cancelled")
    await prisma.batchExport.updateMany({
      where: { id: running.id, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", error: null },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "batches.export.cancel",
        batchId: batch.id,
        exportId: running.id,
      })
    )

    const record = await latestBatchExport(batch.id)
    return jsonResponse({
      export: record ? withDownloadUrl(record, batch) : null,
    })
  } catch (error) {
    return handleRouteError(error, "batches.export.cancel")
  }
}
