import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  rateLimitResponse,
} from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { randomId } from "@/lib/documents/ids"
import { loadNormalized } from "@/lib/documents/normalized-store"
import {
  exportRedacted,
  ExportVerificationError,
} from "@/lib/redaction/export"
import { fromDatabaseRow } from "@/lib/redaction/model"
import {
  assertReportOmitsValues,
  buildExportReport,
  ReportLeakError,
  serializeExportReport,
} from "@/lib/redaction/report"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { createDownloadToken } from "@/lib/security/signed-url"
import {
  getObject,
  processedKey,
  putObject,
  reportKey,
} from "@/lib/storage/blob"
import { decryptDocument, encryptWithDocumentKey } from "@/lib/storage/encryption"
import { sha256 } from "@/lib/storage/integrity"
import type { DocumentKind } from "@/types/document"

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

    if (!document.sourceBlobKey || !document.encryptionKey) {
      return errorResponse("Document is not ready", 409)
    }

    const options = optionsSchema.parse(await request.json().catch(() => ({})))

    const record = await prisma.document.findUnique({
      where: { id: document.id },
      select: { normalizedBlobKey: true, checksum: true },
    })
    if (!record?.normalizedBlobKey) {
      return errorResponse("Document is not ready", 409)
    }

    const [model, rows] = await Promise.all([
      loadNormalized(record.normalizedBlobKey, document.encryptionKey),
      // Every redaction, not only the accepted ones: the exporter filters for
      // itself, and the report has to be able to say what was turned down.
      prisma.redaction.findMany({ where: { documentId: document.id } }),
    ])

    const redactions = rows.map(fromDatabaseRow)
    const sealed = await getObject(document.sourceBlobKey)
    const source = decryptDocument(sealed, document.encryptionKey)

    const result = await exportRedacted({
      kind: document.kind as DocumentKind,
      source,
      model,
      redactions,
      options,
      mimeType: document.mimeType,
    })

    const artifactId = randomId("exp", 16)
    const stored = await putObject(
      processedKey(document.id, `${artifactId}.${result.extension}`),
      encryptWithDocumentKey(result.bytes, document.encryptionKey)
    )

    const report = buildExportReport({
      document: {
        id: document.id,
        kind: document.kind as DocumentKind,
        sizeBytes: document.size,
        pageCount: document.pageCount,
        sourceChecksum: record.checksum ?? "",
      },
      artifact: {
        checksum: result.checksum,
        sizeBytes: result.bytes.byteLength,
        mimeType: result.mimeType,
        extension: result.extension,
      },
      options,
      redactions,
      verification: {
        passed: result.verification.passed,
        checkedValues: result.verification.checkedValues,
      },
    })
    // The report is verified the way the export is, and for the same reason:
    // it is about to be handed to someone who was not shown the original.
    assertReportOmitsValues(
      report,
      redactions.filter((redaction) => redaction.status === "accepted")
    )

    const reportBytes = serializeExportReport(report)
    const storedReport = await putObject(
      reportKey(document.id, artifactId),
      encryptWithDocumentKey(reportBytes, document.encryptionKey)
    )

    await prisma.exportArtifact.create({
      data: {
        id: artifactId,
        documentId: document.id,
        blobKey: stored.key,
        checksum: result.checksum,
        mimeType: result.mimeType,
        extension: result.extension,
        size: result.bytes.byteLength,
        appliedRedactions: result.appliedRedactions,
        metadataSanitized: options.sanitizeMetadata,
        labelsAdded: options.addLabels,
        reportBlobKey: storedReport.key,
        reportChecksum: sha256(reportBytes),
      },
    })

    await prisma.document.update({
      where: { id: document.id },
      data: {
        processedBlobKey: stored.key,
        processedChecksum: result.checksum,
      },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.export",
        documentId: document.id,
        appliedRedactions: result.appliedRedactions,
        checkedValues: result.verification.checkedValues,
        size: result.bytes.byteLength,
      })
    )

    const token = createDownloadToken({
      documentId: document.id,
      artifactId,
      ownerKey: document.userFingerprint,
    })

    return jsonResponse({
      artifactId,
      checksum: result.checksum,
      size: result.bytes.byteLength,
      appliedRedactions: result.appliedRedactions,
      metadataSanitized: options.sanitizeMetadata,
      verifiedValues: result.verification.checkedValues,
      downloadUrl: `/api/documents/${document.id}/download?token=${token}`,
      reportUrl: `/api/documents/${document.id}/download?token=${token}&part=report`,
      report,
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
