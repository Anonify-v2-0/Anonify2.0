import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  rateLimitResponse,
  readJson,
} from "@/lib/api/http"
import { MAX_UPLOAD_BYTES } from "@/lib/config"
import { prisma } from "@/lib/database/prisma"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { presignUpload, uploadKey } from "@/lib/storage/blob"
import {
  sealedUploadPlaintextBytes,
  uploadFormatOf,
} from "@/lib/storage/upload-encryption"

export const runtime = "nodejs"

const bodySchema = z.object({
  documentId: z.string().min(1).max(100),
  /** The size of the sealed object the browser is about to PUT. */
  size: z.number().int().positive(),
})

/**
 * A presigned PUT straight into S3, for an install that has enabled it.
 *
 * The /api/upload/local hop costs a function its memory and its time for
 * every byte of every upload, and even carrying ciphertext it is a server
 * holding the upload on the way through. With `S3_PRESIGNED_UPLOADS=true` the
 * browser PUTs to the bucket instead, under the same rules the other paths
 * keep:
 *
 *   - the URL is for one path, the one the reservation fixed, of a document
 *     the caller owns and has not uploaded yet;
 *   - it is only issued for an upload sealed in the browser. This path is
 *     new, so there is no older client that sends plaintext through it, and
 *     it never gets one;
 *   - the object's length is part of the signature, so the bucket refuses
 *     any other number of bytes, and that number is checked here against
 *     the plaintext ceiling first.
 */
export async function POST(request: Request) {
  try {
    const identity = await peekIdentity()

    // Spent from the same allowance as the route it replaces.
    const limit = await consumeRateLimit(
      "upload",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) return rateLimitResponse(limit, "uploads")

    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse("Invalid upload request", 400)
    const { documentId, size } = parsed.data

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        status: true,
        originalName: true,
        userFingerprint: true,
        uploadFormat: true,
      },
    })

    if (!document || document.userFingerprint !== identity?.ownerKey) {
      return errorResponse("Document not found", 404)
    }
    if (document.status !== "uploading") {
      return errorResponse("This document has already been uploaded", 409)
    }
    if (!uploadFormatOf(document.uploadFormat)) {
      return errorResponse(
        "Direct uploads to storage must be encrypted in the browser.",
        400
      )
    }

    const plaintextSize = sealedUploadPlaintextBytes(size)
    if (plaintextSize === null) {
      return errorResponse("Upload is not a sealed file", 400)
    }
    if (plaintextSize === 0) return errorResponse("File is empty", 400)
    if (plaintextSize > MAX_UPLOAD_BYTES) {
      return errorResponse("File is too large", 413)
    }

    const presigned = await presignUpload(
      uploadKey(document.id, document.originalName),
      size
    )
    if (!presigned) {
      return errorResponse(
        "This deployment does not upload straight to storage; it uploads through /api/upload/local.",
        409
      )
    }

    return jsonResponse({
      url: presigned.url,
      method: "PUT",
      headers: presigned.headers,
      handle: presigned.handle,
      expiresAt: presigned.expiresAt.toISOString(),
    })
  } catch (error) {
    return handleRouteError(error, "upload.presign")
  }
}
