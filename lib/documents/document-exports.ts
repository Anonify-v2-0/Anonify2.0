import { prisma } from "@/lib/database/prisma"
import { randomId } from "@/lib/documents/ids"
import type { ExportStage } from "@/lib/redaction/export"
import type { ExportReport } from "@/lib/redaction/report"
import { createDownloadToken } from "@/lib/security/signed-url"
import { deleteObject, reportKey, vaultKey } from "@/lib/storage/blob"
import { documentSeal, getSealed } from "@/lib/storage/sealed"

/**
 * Single exports, run in the background (#187).
 *
 * The record a run writes and the dialog reads: where the export has got
 * to, what it produced, and why it stopped if it did. Built like the batch
 * export's (lib/documents/batch-exports.ts), for one document.
 */

export const DOCUMENT_EXPORT_STATUSES = [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
] as const

export type DocumentExportStatus = (typeof DOCUMENT_EXPORT_STATUSES)[number]

export const ACTIVE_EXPORT_STATUSES = ["queued", "running"] as const

/** Where a run has got to. Names and counts; never anything from the file. */
export type DocumentExportProgress = {
  stage: ExportStage
  /** The variant being exported, by name, and its place in the request. */
  variant: string
  variantIndex: number
  variants: number
  /** Pages drawn, and of how many, while rendering a PDF. */
  done?: number
  total?: number
}

export const newDocumentExportId = () => randomId("dex", 16)

/**
 * The id of a variant's artifact: fixed by the export and the variant's
 * place, so a step that runs again writes over what it wrote before rather
 * than leaving a second copy.
 */
export function artifactIdFor(exportId: string, index: number): string {
  return `exp_${exportId.replace(/^dex_/, "")}${index.toString(36)}`
}

export type DescribedArtifact = {
  artifactId: string
  variant: string
  checksum: string
  size: number
  appliedRedactions: number
  verifiedValues: number
  downloadUrl: string
  reportUrl: string
  report: ExportReport | null
  /**
   * Where the vault's envelope can be fetched, once, when this variant has
   * one. Sealed to the requesting browser; see lib/redaction/vault-envelope.ts.
   */
  vaultUrl: string | null
}

export type DocumentExportView = {
  id: string
  status: DocumentExportStatus
  progress: DocumentExportProgress | null
  error: string | null
  metadataSanitized: boolean
  streamUrl: string
  /** Present once the export is ready. */
  artifacts: DescribedArtifact[] | null
}

type DocumentRow = {
  id: string
  userFingerprint: string
  encryptionKey: string | null
  encryptionFormat?: string | null
}

export async function findDocumentExport(documentId: string, exportId: string) {
  return prisma.documentExport.findFirst({
    where: { id: exportId, documentId },
  })
}

/** The newest export of a document, for a dialog that is opened again. */
export async function latestDocumentExport(documentId: string) {
  return prisma.documentExport.findFirst({
    where: { documentId },
    orderBy: { createdAt: "desc" },
  })
}

async function readReport(
  document: DocumentRow,
  artifactId: string,
  blobKey: string | null
): Promise<ExportReport | null> {
  if (!blobKey || !document.encryptionKey) return null
  try {
    const bytes = await getSealed(
      blobKey,
      reportKey(document.id, artifactId),
      documentSeal(document as Parameters<typeof documentSeal>[0])
    )
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as ExportReport
  } catch {
    // The report is a courtesy here: the file and its link stand without it.
    return null
  }
}

/**
 * The export as the dialog and the API see it. Download links are minted on
 * each read, as the batch export's are, so none of them outlives its token.
 */
export async function documentExportView(
  record: NonNullable<Awaited<ReturnType<typeof findDocumentExport>>>,
  document: DocumentRow
): Promise<DocumentExportView> {
  const base = `/api/documents/${document.id}/export/${record.id}`
  let artifacts: DescribedArtifact[] | null = null

  if (record.status === "ready") {
    const rows = await prisma.exportArtifact.findMany({
      where: { exportId: record.id, documentId: document.id },
      orderBy: { id: "asc" },
    })
    artifacts = await Promise.all(
      rows.map(async (row) => {
        const token = createDownloadToken({
          documentId: document.id,
          artifactId: row.id,
          ownerKey: document.userFingerprint,
        })
        const report = await readReport(document, row.id, row.reportBlobKey)
        return {
          artifactId: row.id,
          variant: row.variant ?? "redacted",
          checksum: row.checksum,
          size: row.size,
          appliedRedactions: row.appliedRedactions,
          verifiedValues: report?.verification.checkedValues ?? 0,
          downloadUrl: `/api/documents/${document.id}/download?token=${token}`,
          reportUrl: `/api/documents/${document.id}/download?token=${token}&part=report`,
          report,
          vaultUrl:
            row.vaultBlobKey && row.vaultRecipient
              ? `${base}/vault?artifact=${encodeURIComponent(row.id)}`
              : null,
        }
      })
    )
  }

  return {
    id: record.id,
    status: record.status as DocumentExportStatus,
    progress: (record.progress as DocumentExportProgress | null) ?? null,
    error: record.error,
    metadataSanitized: record.metadataSanitized,
    streamUrl: `${base}/stream`,
    artifacts,
  }
}

/**
 * The sealed vault envelope of one artifact, handed over once.
 *
 * Read, then deleted, and the row cleared, so it can be fetched exactly once.
 * The envelope opens only with the requesting browser's private key, so
 * nothing stored here could open it anyway; deleting it is so that nothing
 * stored here is a vault at all for longer than it has to be. Null when it
 * was never stored or has already been taken.
 */
export async function takeVaultEnvelope(
  document: DocumentRow,
  exportId: string,
  artifactId: string
): Promise<Uint8Array | null> {
  const artifact = await prisma.exportArtifact.findFirst({
    where: {
      id: artifactId,
      exportId,
      documentId: document.id,
      vaultRecipient: true,
    },
    select: { vaultBlobKey: true },
  })
  if (!artifact?.vaultBlobKey || !document.encryptionKey) return null

  // Claimed before it is read, so two readers cannot both take it.
  const claimed = await prisma.exportArtifact.updateMany({
    where: { id: artifactId, vaultBlobKey: artifact.vaultBlobKey },
    data: { vaultBlobKey: null, vaultChecksum: null },
  })
  if (claimed.count === 0) return null

  try {
    return await getSealed(
      artifact.vaultBlobKey,
      vaultKey(document.id, artifactId),
      documentSeal(document as Parameters<typeof documentSeal>[0])
    )
  } finally {
    await deleteObject(artifact.vaultBlobKey).catch(() => undefined)
  }
}
