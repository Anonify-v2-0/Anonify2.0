import { contentDisposition } from "@/lib/api/content-disposition"
import { errorResponse, handleRouteError, streamResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { verifyDownloadToken } from "@/lib/security/signed-url"
import { artifactKey, reportKey } from "@/lib/storage/blob"
import { documentSeal, getSealedStream } from "@/lib/storage/sealed"
import { ChecksumVerifier } from "@/lib/storage/integrity"
import { chain } from "@/lib/storage/streams"

export const runtime = "nodejs"

/**
 * Serves a generated export.
 *
 * The signed token is necessary but not sufficient: session ownership is
 * re-checked on every request, and the bytes are re-hashed and compared against
 * the checksum recorded at export time, so what the user downloads is provably
 * the artifact that was verified.
 *
 * Streamed: the artifact is decrypted a chunk at a time and hashed as it
 * passes, and its last piece is held until the hash matches. A mismatch breaks
 * the download off short rather than completing it — see `ChecksumVerifier` —
 * so a file that failed the check is never delivered whole, and a large one is
 * never whole in this process.
 *
 * `?part=report` serves the export report for the same artifact, through the
 * same token and the same integrity check — it is a second file, not a second
 * kind of authorization.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/documents/[id]/download">
) {
  try {
    const { id } = await context.params
    const url = new URL(request.url)
    const token = url.searchParams.get("token")

    if (!token) return errorResponse("Missing download token", 401)

    const verified = verifyDownloadToken(token)
    if (!verified || verified.documentId !== id) {
      return errorResponse("This download link is invalid or has expired", 401)
    }

    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)

    if (verified.ownerKey !== document.userFingerprint) {
      return errorResponse("This download link is not yours", 403)
    }

    const artifact = await prisma.exportArtifact.findFirst({
      where: { id: verified.artifactId, documentId: document.id },
    })
    if (!artifact || !document.encryptionKey) {
      return errorResponse("Export not found", 404)
    }

    const wantsReport = url.searchParams.get("part") === "report"
    const reportBlob = wantsReport ? artifact.reportBlobKey : null
    if (wantsReport && !reportBlob) {
      // Artifacts exported before reports existed have none, and generating one
      // now would describe a review that has since moved on.
      return errorResponse("This export has no report", 404)
    }

    const blobKey = reportBlob ?? artifact.blobKey
    const logicalKey = reportBlob
      ? reportKey(document.id, artifact.id)
      : artifactKey(document.id, artifact.id, artifact.extension)
    const expectedChecksum = reportBlob
      ? (artifact.reportChecksum ?? "")
      : artifact.checksum

    const source = await getSealedStream(
      blobKey,
      logicalKey,
      documentSeal(document)
    )
    const body = chain(
      source,
      new ChecksumVerifier(expectedChecksum, () =>
        console.error(
          JSON.stringify({
            level: "error",
            context: "documents.download",
            documentId: document.id,
            errorCategory: "checksum-mismatch",
          })
        )
      )
    )

    const base = document.originalName.replace(/\.[^.]+$/, "") || "document"
    const filename = wantsReport
      ? `${base}-redaction-report.json`
      : `${base}-redacted.${artifact.extension}`

    return streamResponse(body, {
      "content-type": wantsReport ? "application/json" : artifact.mimeType,
      "content-disposition": contentDisposition(filename),
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    })
  } catch (error) {
    return handleRouteError(error, "documents.download")
  }
}
