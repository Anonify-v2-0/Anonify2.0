import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  rateLimitResponse,
  readFormData,
} from "@/lib/api/http"
import { MAX_UPLOAD_BYTES } from "@/lib/config"
import { prisma } from "@/lib/database/prisma"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { putObject, uploadKey } from "@/lib/storage/blob"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Browser uploads for every backend that is not Vercel Blob.
 *
 * Vercel Blob issues a scoped token and the browser uploads straight to it. S3
 * and the local filesystem have no equivalent the browser can safely use, so
 * the bytes come through here instead and are written with the same storage
 * abstraction everything else reads from. Downstream — ingest, extraction,
 * export — cannot tell the difference, which is the point.
 *
 * This is a self-hosted path, so there is no serverless body limit to work
 * around; the ceiling is the application's own MAX_UPLOAD_BYTES.
 */
export async function POST(request: Request) {
  try {
    const identity = await peekIdentity()

    const limit = await consumeRateLimit(
      "upload",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) {
      return rateLimitResponse(limit, "uploads")
    }

    const form = await readFormData(request)
    if (!form) return errorResponse("Expected a multipart upload", 400)

    const documentId = String(form.get("documentId") ?? "").trim()
    const file = form.get("file")

    if (!documentId) return errorResponse("Missing document reference", 400)
    if (!(file instanceof File)) return errorResponse("No file supplied", 400)
    if (file.size === 0) return errorResponse("File is empty", 400)
    if (file.size > MAX_UPLOAD_BYTES) return errorResponse("File is too large", 413)

    // The same ownership check the Vercel token route makes before signing.
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        status: true,
        originalName: true,
        userFingerprint: true,
      },
    })

    if (!document || document.userFingerprint !== identity?.ownerKey) {
      return errorResponse("Document not found", 404)
    }
    if (document.status !== "uploading") {
      return errorResponse("This document has already been uploaded", 409)
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const stored = await putObject(
      uploadKey(document.id, document.originalName),
      bytes
    )

    return jsonResponse({ url: stored.key, size: stored.size }, 201)
  } catch (error) {
    return handleRouteError(error, "upload.local")
  }
}
