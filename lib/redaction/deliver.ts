import { prisma } from "@/lib/database/prisma"
import { randomId } from "@/lib/documents/ids"
import { loadNormalized } from "@/lib/documents/normalized-store"
import type { ExportOptions } from "@/lib/redaction/apply"
import { exportRedacted } from "@/lib/redaction/export"
import { fromDatabaseRow } from "@/lib/redaction/model"
import { presetById } from "@/lib/redaction/presets"
import {
  assertReportOmitsValues,
  buildExportReport,
  serializeExportReport,
  type ExportReport,
} from "@/lib/redaction/report"
import { getObject, processedKey, putObject, reportKey } from "@/lib/storage/blob"
import { decryptDocument, encryptWithDocumentKey } from "@/lib/storage/encryption"
import { sha256 } from "@/lib/storage/integrity"
import type { DocumentKind } from "@/types/document"

/**
 * Generating an export and storing it.
 *
 * One document's worth of the whole thing: build it from the accepted
 * redactions, let the exporter verify it against the artifact it just produced,
 * write the report, seal both and record them. It lives here rather than in the
 * route because a batch export is this, several times — and a second copy of
 * these steps is a second place for the verification gate to be forgotten.
 */

export type DeliveredExport = {
  artifactId: string
  checksum: string
  size: number
  bytes: Uint8Array
  extension: string
  mimeType: string
  appliedRedactions: number
  verifiedValues: number
  report: ExportReport
}

export type ExportOutcome =
  | { ok: true; delivered: DeliveredExport }
  /** No normalized model or no sealed source: there is nothing to export yet. */
  | { ok: false; reason: "not-ready" }

export async function exportAndStore(
  documentId: string,
  options: ExportOptions
): Promise<ExportOutcome> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      kind: true,
      mimeType: true,
      size: true,
      pageCount: true,
      checksum: true,
      preset: true,
      encryptionKey: true,
      sourceBlobKey: true,
      normalizedBlobKey: true,
    },
  })

  if (
    !document?.sourceBlobKey ||
    !document.encryptionKey ||
    !document.normalizedBlobKey
  ) {
    return { ok: false, reason: "not-ready" }
  }

  const [model, rows] = await Promise.all([
    loadNormalized(document.normalizedBlobKey, document.encryptionKey),
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
      sourceChecksum: document.checksum ?? "",
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
    preset: presetById(document.preset),
  })

  // The report is verified the way the export is, and for the same reason: it
  // is about to be handed to someone who was not shown the original.
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

  return {
    ok: true,
    delivered: {
      artifactId,
      checksum: result.checksum,
      size: result.bytes.byteLength,
      bytes: result.bytes,
      extension: result.extension,
      mimeType: result.mimeType,
      appliedRedactions: result.appliedRedactions,
      verifiedValues: result.verification.checkedValues,
      report,
    },
  }
}
