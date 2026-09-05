import { z } from "zod"

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { requireBatch } from "@/lib/documents/batches"
import { listBatchDocuments } from "@/lib/documents/listing"
import type { SkipReason } from "@/lib/redaction/archive"
import { exportAndStore } from "@/lib/redaction/deliver"
import { ExportVerificationError } from "@/lib/redaction/export"
import { ReportLeakError } from "@/lib/redaction/report"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { createBatchToken } from "@/lib/security/signed-url"

export const runtime = "nodejs"
export const maxDuration = 300

const optionsSchema = z.object({
  addLabels: z.boolean().default(false),
  sanitizeMetadata: z.boolean().default(true),
  imageStyle: z.enum(["solid", "blur", "pixelate"]).default("solid"),
})

/**
 * Exports every document in the batch.
 *
 * Each document is exported exactly as it would be on its own — the same
 * builder, the same verification gate, the same stored artifact and report. The
 * batch adds one rule and it is the important one: **a document that fails does
 * not hold up the rest.** A refused verification, a document still processing,
 * an exhausted export allowance — each of those removes one document from the
 * archive and is named in the response, rather than failing the batch.
 *
 * Rate limiting is charged per document, because that is what the work is. When
 * the allowance runs out partway, the documents already exported stand and the
 * remainder are reported as skipped, with the reason, so the reviewer can come
 * back for them rather than losing the ones that succeeded.
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

    const documents = await listBatchDocuments(batch.id)
    if (documents.length === 0) {
      return errorResponse("This batch has no documents left", 409)
    }

    const exported: { documentId: string; artifactId: string; removed: number }[] = []
    const skipped: { documentId: string; reason: SkipReason }[] = []
    let allowanceGone = false

    for (const document of documents) {
      if (allowanceGone) {
        skipped.push({ documentId: document.id, reason: "rate-limited" })
        continue
      }

      if (document.status !== "ready") {
        skipped.push({ documentId: document.id, reason: "not-ready" })
        continue
      }

      const limit = await consumeRateLimit(
        "export",
        identity?.networkKey ?? "anonymous"
      )
      if (!limit.allowed) {
        allowanceGone = true
        skipped.push({ documentId: document.id, reason: "rate-limited" })
        continue
      }

      try {
        const outcome = await exportAndStore(document.id, options)
        if (!outcome.ok) {
          skipped.push({ documentId: document.id, reason: "not-ready" })
          continue
        }

        exported.push({
          documentId: document.id,
          artifactId: outcome.delivered.artifactId,
          removed: outcome.delivered.appliedRedactions,
        })
      } catch (error) {
        // One document's failure is one document's failure. It is logged with
        // its category, left out of the archive, and named in the response —
        // never delivered, and never allowed to cost the others their export.
        const reason: SkipReason =
          error instanceof ExportVerificationError ||
          error instanceof ReportLeakError
            ? "verification-failed"
            : "export-failed"

        console.error(
          JSON.stringify({
            level: "error",
            context: "batches.export",
            batchId: batch.id,
            documentId: document.id,
            errorCategory: reason,
          })
        )

        skipped.push({ documentId: document.id, reason })
      }
    }

    if (exported.length === 0) {
      return jsonResponse({ exported, skipped, downloadUrl: null }, 409)
    }

    const token = createBatchToken({
      batchId: batch.id,
      ownerKey: batch.userFingerprint,
    })

    return jsonResponse({
      exported,
      skipped,
      downloadUrl: `/api/batches/${batch.id}/download?token=${token}`,
    })
  } catch (error) {
    return handleRouteError(error, "batches.export")
  }
}
