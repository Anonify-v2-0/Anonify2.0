import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
  rateLimitResponse,
} from "@/lib/api/http"
import { ALLOWED_TTL_SECONDS, MAX_UPLOAD_BYTES } from "@/lib/config"
import { listDocuments } from "@/lib/documents/listing"
import { reserveDocument } from "@/lib/documents/reserve"
import { getIdentity, peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { clientUploadMode } from "@/lib/storage/blob"
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
      return rateLimitResponse(limit, "uploads")
    }

    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse("Invalid upload request", 400)
    }

    const { filename, size, contentType, ttlSeconds } = parsed.data

    const reserved = await reserveDocument({
      filename,
      size,
      contentType,
      ttlSeconds,
      ownerKey: identity.ownerKey,
      quotaKey: identity.quotaKey,
    })

    if (!reserved.ok) {
      return errorResponse(reserved.message, reserved.status, reserved.quota)
    }

    return jsonResponse(
      {
        id: reserved.id,
        pathname: reserved.pathname,
        expiresAt: reserved.expiresAt.toISOString(),
        quota: reserved.quota,
        // The server knows which storage backend is configured; the browser
        // should not have to be told separately through a public env var.
        uploadMode: clientUploadMode(),
      },
      201
    )
  } catch (error) {
    return handleRouteError(error, "documents.create")
  }
}
