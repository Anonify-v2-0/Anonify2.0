import { z } from "zod"

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import {
  ACCEPTED_MIME_TYPES,
  ALLOWED_TTL_SECONDS,
  MAX_UPLOAD_BYTES,
} from "@/lib/config"
import { prisma } from "@/lib/database/prisma"
import { extensionOf } from "@/lib/documents/detect"
import { newDocumentId } from "@/lib/documents/ids"
import { getIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { uploadKey } from "@/lib/storage/blob"
import { DEFAULT_TTL_SECONDS } from "@/types/document"

export const runtime = "nodejs"

const EXTENSION_KINDS: Record<string, string> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
}

const createSchema = z.object({
  filename: z.string().min(1).max(200),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  contentType: z.string().max(200).optional(),
  ttlSeconds: z
    .number()
    .int()
    .refine((value) => (ALLOWED_TTL_SECONDS as number[]).includes(value))
    .default(DEFAULT_TTL_SECONDS),
})

/**
 * Reserves a document before the browser uploads to Blob storage.
 *
 * The client uploads directly, so the server has to stake its claim first: this
 * is where the quota, the rate limit and the caller's ownership are decided,
 * and it fixes the upload path the token route will later agree to sign.
 */
export async function POST(request: Request) {
  try {
    const identity = await getIdentity()

    const limit = await consumeRateLimit("upload", identity.networkKey)
    if (!limit.allowed) {
      return errorResponse("Too many uploads. Try again shortly.", 429, {
        resetAt: limit.resetAt.toISOString(),
      })
    }

    const parsed = createSchema.safeParse(await request.json())
    if (!parsed.success) {
      return errorResponse("Invalid upload request", 400)
    }

    const { filename, size, contentType, ttlSeconds } = parsed.data

    const kind = EXTENSION_KINDS[extensionOf(filename)]
    if (!kind) {
      return errorResponse("Unsupported file type", 415)
    }
    if (contentType && ACCEPTED_MIME_TYPES[contentType] === undefined) {
      return errorResponse("Unsupported file type", 415)
    }

    const documentId = newDocumentId()
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

    await prisma.document.create({
      data: {
        id: documentId,
        originalName: filename,
        // Both are provisional: ingest re-derives them from the actual bytes.
        kind,
        mimeType: contentType ?? "application/octet-stream",
        size,
        status: "uploading",
        userFingerprint: identity.ownerKey,
        ttlSeconds,
        expiresAt,
      },
    })

    return jsonResponse(
      {
        id: documentId,
        pathname: uploadKey(documentId, filename),
        expiresAt: expiresAt.toISOString(),
      },
      201
    )
  } catch (error) {
    return handleRouteError(error, "documents.create")
  }
}
