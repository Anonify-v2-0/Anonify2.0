import { errorResponse, handleRouteError } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { verifyDownloadToken } from "@/lib/security/signed-url"
import { getObject } from "@/lib/storage/blob"
import { decryptDocument } from "@/lib/storage/encryption"
import { checksumMatches, sha256 } from "@/lib/storage/integrity"

export const runtime = "nodejs"

/**
 * Serves a generated export.
 *
 * The signed token is necessary but not sufficient: session ownership is
 * re-checked on every request, and the bytes are re-hashed and compared against
 * the checksum recorded at export time, so what the user downloads is provably
 * the artifact that was verified.
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

    const sealed = await getObject(artifact.blobKey)
    const bytes = decryptDocument(sealed, document.encryptionKey)

    if (!checksumMatches(artifact.checksum, sha256(bytes))) {
      console.error(
        JSON.stringify({
          level: "error",
          context: "documents.download",
          documentId: document.id,
          errorCategory: "checksum-mismatch",
        })
      )
      return errorResponse("The stored export failed its integrity check", 500)
    }

    const base = document.originalName.replace(/\.[^.]+$/, "") || "document"
    const filename = `${base}-redacted.${artifact.extension}`

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": artifact.mimeType,
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
      },
    })
  } catch (error) {
    return handleRouteError(error, "documents.download")
  }
}
