import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { ACCEPTED_MIME_TYPES, MAX_UPLOAD_BYTES } from "@/lib/config"
import { prisma } from "@/lib/database/prisma"
import { peekIdentity } from "@/lib/security/fingerprint"
import { uploadKey } from "@/lib/storage/blob"

export const runtime = "nodejs"

/**
 * Issues short-lived client upload tokens.
 *
 * The browser never gets a general-purpose write token: each one is scoped to a
 * single path that belongs to a document the caller already reserved and still
 * owns, with the accepted media types and the size ceiling baked in.
 */
export async function POST(request: Request) {
  try {
    // Only reachable when Vercel Blob is the configured backend; say so plainly
    // rather than failing inside the SDK with something less legible.
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return errorResponse(
        "Vercel Blob is not configured; this deployment uploads through /api/upload/local.",
        409
      )
    }

    const body = (await request.json()) as HandleUploadBody
    const identity = await peekIdentity()

    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const documentId = clientPayload?.trim()
        if (!documentId) throw new Error("Missing document reference")

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
          throw new Error("Document not found")
        }
        if (document.status !== "uploading") {
          throw new Error("This document has already been uploaded")
        }
        if (pathname !== uploadKey(document.id, document.originalName)) {
          throw new Error("Upload path does not match this document")
        }

        return {
          allowedContentTypes: Object.keys(ACCEPTED_MIME_TYPES),
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: false,
          // The token outlives a slow multipart upload but not much more.
          validUntil: Date.now() + 30 * 60 * 1000,
          tokenPayload: document.id,
        }
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Vercel calls this webhook in production; locally it never fires, so
        // the client's own process request is what actually advances the run.
        if (!tokenPayload) return
        await prisma.document.updateMany({
          where: { id: tokenPayload, status: "uploading" },
          data: { uploadBlobKey: blob.url },
        })
      },
    })

    return jsonResponse(result)
  } catch (error) {
    return handleRouteError(error, "upload.token")
  }
}
