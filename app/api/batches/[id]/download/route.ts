import { errorResponse, handleRouteError } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireBatch } from "@/lib/documents/batches"
import { listBatchDocuments } from "@/lib/documents/listing"
import {
  artifactName,
  buildArchive,
  buildBatchReport,
  reportName,
  vaultName,
  serializeBatchReport,
  type ArchiveFile,
  type SkipReason,
} from "@/lib/redaction/archive"
import type { ExportReport } from "@/lib/redaction/report"
import { peekIdentity } from "@/lib/security/fingerprint"
import { verifyBatchToken } from "@/lib/security/signed-url"
import { getObject } from "@/lib/storage/blob"
import { decryptDocument } from "@/lib/storage/encryption"
import { checksumMatches, sha256 } from "@/lib/storage/integrity"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * The archive is assembled in memory, so it needs a ceiling. A batch that
 * exceeds it delivers what fits and names the rest as skipped, rather than
 * taking the process down and delivering nothing.
 */
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024

/**
 * The batch archive: one export per document, plus its report, plus a roll-up.
 *
 * Nothing new is generated here. The archive is assembled from the artifacts
 * the export already produced and verified, and every one of them is re-hashed
 * against the checksum recorded at that time — so a file in the archive is
 * provably the file that passed verification, exactly as it is for a single
 * download.
 *
 * An artifact that fails that check is left out and named in the batch report,
 * rather than quietly included or allowed to fail the whole archive.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/batches/[id]/download">
) {
  try {
    const { id } = await context.params
    const token = new URL(request.url).searchParams.get("token")
    if (!token) return errorResponse("Missing download token", 401)

    const verified = verifyBatchToken(token)
    if (!verified || verified.batchId !== id) {
      return errorResponse("This download link is invalid or has expired", 401)
    }

    const identity = await peekIdentity()
    const batch = await requireBatch(id, identity?.ownerKey)

    if (verified.ownerKey !== batch.userFingerprint) {
      return errorResponse("This download link is not yours", 403)
    }

    const documents = await listBatchDocuments(batch.id)
    const files: ArchiveFile[] = []
    const reports: ExportReport[] = []
    const skipped: { documentId: string; reason: SkipReason }[] = []
    /** Documents whose vault made it into the archive, for the batch report. */
    const vaulted = new Set<string>()
    let archiveBytes = 0

    for (const document of documents) {
      // The most recent export of each document, which is what the export call
      // that issued this token has just produced. A document exported again in
      // between contributes the newer artifact — still current, still verified.
      const artifact = await prisma.exportArtifact.findFirst({
        where: { documentId: document.id, reportBlobKey: { not: null } },
        orderBy: { createdAt: "desc" },
      })

      const record = await prisma.document.findUnique({
        where: { id: document.id },
        select: { encryptionKey: true },
      })

      if (!artifact?.reportBlobKey || !record?.encryptionKey) {
        skipped.push({ documentId: document.id, reason: "not-ready" })
        continue
      }

      const [sealed, sealedReport] = await Promise.all([
        getObject(artifact.blobKey),
        getObject(artifact.reportBlobKey),
      ])

      const bytes = decryptDocument(sealed, record.encryptionKey)
      const reportBytes = decryptDocument(sealedReport, record.encryptionKey)

      if (
        !checksumMatches(artifact.checksum, sha256(bytes)) ||
        !checksumMatches(artifact.reportChecksum ?? "", sha256(reportBytes))
      ) {
        console.error(
          JSON.stringify({
            level: "error",
            context: "batches.download",
            batchId: batch.id,
            documentId: document.id,
            errorCategory: "checksum-mismatch",
          })
        )
        skipped.push({ documentId: document.id, reason: "export-failed" })
        continue
      }

      if (archiveBytes + bytes.byteLength > MAX_ARCHIVE_BYTES) {
        skipped.push({ documentId: document.id, reason: "archive-full" })
        continue
      }
      archiveBytes += bytes.byteLength

      files.push({
        name: artifactName(document.originalName, artifact.extension),
        bytes,
      })
      files.push({ name: reportName(document.originalName), bytes: reportBytes })
      reports.push(JSON.parse(Buffer.from(reportBytes).toString("utf8")))

      // The vault, for a file the reviewer had tokenized or encrypted. Named
      // after its own document, because it opens that one and no other.
      //
      // A vault that fails its checksum is left out rather than shipped: half
      // a mapping restores half a document, and a reviewer would have no way
      // to tell which half. The file itself still goes in — it is verified
      // separately and is not made wrong by an unreadable vault — and the
      // batch report says which documents ended up with one.
      if (artifact.vaultBlobKey) {
        const sealedVault = await getObject(artifact.vaultBlobKey)
        const vaultBytes = decryptDocument(sealedVault, record.encryptionKey)

        if (checksumMatches(artifact.vaultChecksum ?? "", sha256(vaultBytes))) {
          files.push({
            name: vaultName(document.originalName),
            bytes: vaultBytes,
          })
          vaulted.add(document.id)
        } else {
          console.error(
            JSON.stringify({
              level: "error",
              context: "batches.download",
              batchId: batch.id,
              documentId: document.id,
              errorCategory: "vault-checksum-mismatch",
            })
          )
        }
      }
    }

    if (files.length === 0) {
      return errorResponse("This batch has nothing exported yet", 409)
    }

    files.push({
      name: "batch-report.json",
      bytes: serializeBatchReport(
        buildBatchReport({ batchId: batch.id, reports, skipped, vaulted })
      ),
    })

    const archive = buildArchive(files)

    return new Response(new Uint8Array(archive), {
      headers: {
        "content-type": "application/zip",
        "content-length": String(archive.byteLength),
        "content-disposition": `attachment; filename="anonify-batch-redacted.zip"`,
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
      },
    })
  } catch (error) {
    return handleRouteError(error, "batches.download")
  }
}
