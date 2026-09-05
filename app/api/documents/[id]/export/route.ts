import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  rateLimitResponse,
} from "@/lib/api/http"
import { exportAndStore } from "@/lib/redaction/deliver"
import { ExportVerificationError } from "@/lib/redaction/export"
import { ReportLeakError } from "@/lib/redaction/report"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { createDownloadToken } from "@/lib/security/signed-url"

export const runtime = "nodejs"
export const maxDuration = 300

const optionsSchema = z.object({
  addLabels: z.boolean().default(false),
  sanitizeMetadata: z.boolean().default(true),
  imageStyle: z.enum(["solid", "blur", "pixelate"]).default("solid"),
})

/**
 * Generates the redacted document.
 *
 * Deterministic from the accepted redactions, verified against the artifact it
 * just produced, checksummed, stored encrypted, and handed back as a signed
 * short-lived link rather than a storage URL. A verification failure is a
 * refusal to deliver — never a warning attached to a leaking file.
 *
 * The work itself is in lib/redaction/deliver.ts, shared with the batch export
 * so there is one definition of what an export is and one verification gate.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/export">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const limit = await consumeRateLimit(
      "export",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) {
      return rateLimitResponse(limit, "exports")
    }

    const document = await requireDocument(id, identity?.ownerKey)
    const options = optionsSchema.parse(await request.json().catch(() => ({})))

    const outcome = await exportAndStore(document.id, options)
    if (!outcome.ok) {
      return errorResponse("Document is not ready", 409)
    }

    const { delivered } = outcome

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.export",
        documentId: document.id,
        appliedRedactions: delivered.appliedRedactions,
        checkedValues: delivered.verifiedValues,
        size: delivered.size,
      })
    )

    const token = createDownloadToken({
      documentId: document.id,
      artifactId: delivered.artifactId,
      ownerKey: document.userFingerprint,
    })

    return jsonResponse({
      artifactId: delivered.artifactId,
      checksum: delivered.checksum,
      size: delivered.size,
      appliedRedactions: delivered.appliedRedactions,
      metadataSanitized: options.sanitizeMetadata,
      verifiedValues: delivered.verifiedValues,
      downloadUrl: `/api/documents/${document.id}/download?token=${token}`,
      reportUrl: `/api/documents/${document.id}/download?token=${token}&part=report`,
      report: delivered.report,
    })
  } catch (error) {
    if (error instanceof ExportVerificationError) {
      // Log which values survived for the operator; tell the client only that
      // the export was refused.
      console.error(
        JSON.stringify({
          level: "error",
          context: "documents.export",
          errorCategory: "verification-failed",
          leakedCount: error.report.leaked.length,
        })
      )
      return errorResponse(
        "The generated document did not pass verification and was not saved.",
        500
      )
    }
    if (error instanceof ReportLeakError) {
      // The report is refused for the same reason a failed export is: it was
      // about to disclose the values it exists to account for.
      console.error(
        JSON.stringify({
          level: "error",
          context: "documents.export",
          errorCategory: "report-leak",
          fields: error.fields,
        })
      )
      return errorResponse(
        "The export report did not pass verification and was not saved.",
        500
      )
    }
    return handleRouteError(error, "documents.export")
  }
}
