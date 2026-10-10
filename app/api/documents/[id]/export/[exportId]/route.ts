import { getRun } from "workflow/api"

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import {
  documentExportView,
  findDocumentExport,
} from "@/lib/documents/document-exports"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"

export const runtime = "nodejs"

/**
 * One background export (#187): its status and progress, and once it is
 * ready, its artifacts with download links minted for this read. A vault is
 * not here: it is fetched once, sealed, from `vault`.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/documents/[id]/export/[exportId]">
) {
  try {
    const { id, exportId } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)
    const record = await findDocumentExport(document.id, exportId)
    if (!record) return errorResponse("Export not found", 404)
    return jsonResponse({ export: await documentExportView(record, document) })
  } catch (error) {
    return handleRouteError(error, "documents.export.status")
  }
}

/**
 * Stops an export in progress. The variant being built is finished and
 * kept, as a batch keeps its current document; nothing after it starts.
 */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/documents/[id]/export/[exportId]">
) {
  try {
    const { id, exportId } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)
    const record = await findDocumentExport(document.id, exportId)
    if (!record) return errorResponse("Export not found", 404)
    if (record.status !== "queued" && record.status !== "running") {
      return errorResponse("That export is not running", 409)
    }

    await prisma.documentExport.updateMany({
      where: { id: exportId, status: { in: ["queued", "running"] } },
      data: { cancelRequested: true },
    })
    if (record.workflowRunId) {
      try {
        await getRun(record.workflowRunId).cancel()
      } catch {
        // Already finished or cancelled: the row below is the record.
      }
    }
    // The run's own closing step will not run once it is cancelled.
    await prisma.documentExport.updateMany({
      where: { id: exportId, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", error: null },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.export.cancel",
        documentId: document.id,
        exportId,
      })
    )
    const updated = await findDocumentExport(document.id, exportId)
    return jsonResponse({
      export: updated ? await documentExportView(updated, document) : null,
    })
  } catch (error) {
    return handleRouteError(error, "documents.export.cancel")
  }
}
