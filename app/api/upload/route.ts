import { after } from "next/server"

import {
  ACCEPTED_MIME_TYPES,
  ALLOWED_TTL_SECONDS,
  MAX_UPLOAD_BYTES,
} from "@/lib/config"
import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { detectDocumentType, extensionMatchesKind } from "@/lib/documents/detect"
import { newDocumentId } from "@/lib/documents/ids"
import { getIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { putObject, sourceKey } from "@/lib/storage/blob"
import { encryptDocument } from "@/lib/storage/encryption"
import { sha256 } from "@/lib/storage/integrity"
import { startProcessing } from "@/lib/workflows/process-document"
import { DEFAULT_TTL_SECONDS, type TtlOption } from "@/types/document"

export const runtime = "nodejs"
export const maxDuration = 60

function parseTtl(raw: FormDataEntryValue | null): TtlOption {
  const parsed = Number(raw)
  return (ALLOWED_TTL_SECONDS as number[]).includes(parsed)
    ? (parsed as TtlOption)
    : DEFAULT_TTL_SECONDS
}

export async function POST(request: Request) {
  try {
    const identity = await getIdentity()

    const limit = await consumeRateLimit("upload", identity.networkKey)
    if (!limit.allowed) {
      return errorResponse("Too many uploads. Try again shortly.", 429, {
        resetAt: limit.resetAt.toISOString(),
      })
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0)
    if (contentLength > MAX_UPLOAD_BYTES * 1.1) {
      return errorResponse("File is too large", 413)
    }

    const form = await request.formData()
    const file = form.get("file")
    if (!(file instanceof File)) {
      return errorResponse("No file supplied", 400)
    }

    if (file.size === 0) {
      return errorResponse("File is empty", 400)
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return errorResponse("File is too large", 413)
    }

    const bytes = new Uint8Array(await file.arrayBuffer())

    // The declared MIME type is a hint; the bytes are the authority.
    const detected = detectDocumentType(bytes)
    if (!detected) {
      return errorResponse("Unsupported file type", 415)
    }
    if (!extensionMatchesKind(file.name, detected.kind)) {
      return errorResponse("File contents do not match its extension", 415)
    }
    if (file.type && ACCEPTED_MIME_TYPES[file.type] === undefined) {
      return errorResponse("Unsupported file type", 415)
    }

    const documentId = newDocumentId()
    const checksum = sha256(bytes)
    const { ciphertext, wrappedKey } = encryptDocument(bytes)
    const stored = await putObject(sourceKey(documentId), ciphertext)

    const ttlSeconds = parseTtl(form.get("ttlSeconds"))
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

    await prisma.document.create({
      data: {
        id: documentId,
        originalName: file.name.slice(0, 200) || `document.${detected.extension}`,
        kind: detected.kind,
        mimeType: detected.mimeType,
        size: bytes.byteLength,
        status: "queued",
        sourceBlobKey: stored.key,
        encryptionKey: wrappedKey,
        checksum,
        userFingerprint: identity.ownerKey,
        ttlSeconds,
        expiresAt,
      },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "upload",
        documentId,
        kind: detected.kind,
        size: bytes.byteLength,
        ttlSeconds,
      })
    )

    // Processing runs outside the request so the client can navigate straight
    // to the workspace and watch progress stream in.
    after(() => startProcessing(documentId))

    return jsonResponse(
      {
        id: documentId,
        kind: detected.kind,
        status: "queued",
        expiresAt: expiresAt.toISOString(),
      },
      201
    )
  } catch (error) {
    return handleRouteError(error, "upload")
  }
}
