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
import { listDocuments } from "@/lib/documents/listing"
import { getIdentity, peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { checkQuota, quotaMessage, recordUsage } from "@/lib/security/usage"
import { uploadKey } from "@/lib/storage/blob"
import { DEFAULT_TTL_SECONDS } from "@/types/document"

export const runtime = "nodejs"

/**
 * The caller's own documents, newest first.
 *
 * No session means no documents — not an error. The list is scoped by the same
 * owner key that guards every other read.
 */
export async function GET() {
  try {
    const identity = await peekIdentity()

    // Without a session there is nothing to return and nothing to protect, so
    // this path does no database work at all — including the rate-limit write
    // that would otherwise turn an unauthenticated flood into write load.
    if (!identity) return jsonResponse({ documents: [] })

    await consumeRateLimit("read", identity.networkKey)

    return jsonResponse({ documents: await listDocuments(identity.ownerKey) })
  } catch (error) {
    return handleRouteError(error, "documents.list")
  }
}

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

    // The per-page and per-cell allowances are charged once the pipeline knows
    // the real size; the upload count is charged here, before any work starts.
    const quota = await checkQuota(identity.quotaKey, "uploads")
    if (!quota.allowed) {
      return errorResponse(quotaMessage(quota), 429, {
        limit: quota.limit,
        used: quota.used,
      })
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
        quotaKey: identity.quotaKey,
        ttlSeconds,
        expiresAt,
      },
    })

    await recordUsage({
      fingerprint: identity.quotaKey,
      kind: "uploads",
      quantity: 1,
    })

    return jsonResponse(
      {
        id: documentId,
        pathname: uploadKey(documentId, filename),
        expiresAt: expiresAt.toISOString(),
        quota: { used: quota.used + 1, limit: quota.limit },
      },
      201
    )
  } catch (error) {
    return handleRouteError(error, "documents.create")
  }
}
