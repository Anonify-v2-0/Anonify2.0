import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
} from "@/lib/api/http"
import { describeWait } from "@/lib/api/http"
import { ALLOWED_TTL_SECONDS, MAX_UPLOAD_BYTES } from "@/lib/config"
import { prisma } from "@/lib/database/prisma"
import { newBatchId } from "@/lib/documents/ids"
import { reserveDocument } from "@/lib/documents/reserve"
import { getIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { clientUploadMode } from "@/lib/storage/blob"
import { DEFAULT_TTL_SECONDS } from "@/types/document"

export const runtime = "nodejs"

/** Enough to be a batch, few enough that one request stays a request. */
const MAX_BATCH_FILES = 20

const createSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(200),
        size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
        contentType: z.string().max(200).optional(),
      })
    )
    .min(1)
    .max(MAX_BATCH_FILES),
  ttlSeconds: z
    .number()
    .int()
    .refine((value) => (ALLOWED_TTL_SECONDS as number[]).includes(value))
    .default(DEFAULT_TTL_SECONDS),
})

/**
 * Reserves several documents as one batch.
 *
 * Every file is charged exactly what it would be charged on its own: one upload
 * token from the rate limiter, one upload against the daily quota. A batch is
 * not a discount, and pricing it as one would make the limits meaningless to
 * anyone willing to drag more files at once.
 *
 * What a batch does change is the answer when the allowance runs out partway.
 * Refusing the whole request would throw away the files that were affordable;
 * instead each file gets its own verdict, the accepted ones proceed, and the
 * caller is told which were refused and when to come back for them. The one
 * thing that is not offered is a partial batch pretending to be a whole one.
 */
export async function POST(request: Request) {
  try {
    const identity = await getIdentity()

    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse("Invalid batch request", 400)
    }

    const { files, ttlSeconds } = parsed.data

    const batchId = newBatchId()
    await prisma.batch.create({
      data: { id: batchId, userFingerprint: identity.ownerKey },
    })

    // The index is what the browser matches its own File objects on: two files
    // in one batch can share a name, and pairing by name would upload one of
    // them twice.
    const accepted: {
      index: number
      id: string
      filename: string
      pathname: string
      expiresAt: string
    }[] = []
    const refused: {
      index: number
      filename: string
      reason: string
      retryAfterSeconds?: number
    }[] = []

    // Sequential on purpose: both the token bucket and the daily quota are
    // read-modify-write, and a batch racing itself would let the fifth file
    // spend an allowance the fourth had already taken.
    for (const [index, file] of files.entries()) {
      const limit = await consumeRateLimit("upload", identity.networkKey)
      if (!limit.allowed) {
        const seconds = Math.max(
          1,
          Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000)
        )
        refused.push({
          index,
          filename: file.filename,
          reason: `Upload allowance reached. Try this one again in ${describeWait(seconds)}.`,
          retryAfterSeconds: seconds,
        })
        continue
      }

      const reserved = await reserveDocument({
        filename: file.filename,
        size: file.size,
        contentType: file.contentType,
        ttlSeconds,
        ownerKey: identity.ownerKey,
        quotaKey: identity.quotaKey,
        batchId,
      })

      if (!reserved.ok) {
        refused.push({ index, filename: file.filename, reason: reserved.message })
        continue
      }

      accepted.push({
        index,
        id: reserved.id,
        filename: file.filename,
        pathname: reserved.pathname,
        expiresAt: reserved.expiresAt.toISOString(),
      })
    }

    // A batch nothing got into is not a batch. Removing it here keeps the
    // documents page from filling with empty shells after a refused burst.
    if (accepted.length === 0) {
      await prisma.batch.delete({ where: { id: batchId } })
      return errorResponse(
        refused[0]?.reason ?? "None of those files could be started",
        429,
        { refused }
      )
    }

    return jsonResponse(
      {
        batchId,
        accepted,
        refused,
        uploadMode: clientUploadMode(),
      },
      201
    )
  } catch (error) {
    return handleRouteError(error, "batches.create")
  }
}
