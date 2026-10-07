import { pipeline, Readable, Transform } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"

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
import { putObjectStream, uploadKey } from "@/lib/storage/blob"
import {
  maxSealedUploadBytes,
  sealedUploadPlaintextBytes,
  uploadFormatOf,
} from "@/lib/storage/upload-encryption"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Browser uploads for every backend that is not Vercel Blob.
 *
 * Vercel Blob issues a scoped token and the browser uploads straight to it;
 * S3 and Azure can do the same with a presigned PUT when an operator enables
 * it (see /api/upload/presign). Otherwise — the local filesystem, or a bucket
 * browsers cannot reach — the bytes come through here instead and are written
 * with the same storage abstraction everything else reads from. A browser
 * that sealed its upload sends ciphertext here like everywhere else.
 * Downstream — ingest, extraction, export — cannot tell the difference, which
 * is the point.
 *
 * `PUT` takes the raw body and streams it to storage (#185): memory per
 * upload is the streaming chunk, not the file. The multipart `POST` it
 * replaces held the whole file in memory before writing a byte, so ten
 * uploads at once were half a gigabyte on a web replica with nothing else to
 * do with those bytes. It stays for one release, for API scripts, marked
 * deprecated, and is removed in 1.17.0.
 *
 * This is a self-hosted path, so there is no serverless body limit to work
 * around; the ceiling is the application's own MAX_UPLOAD_BYTES.
 */

/** The release that removes the multipart POST. */
export const MULTIPART_REMOVED_IN = "1.17.0"

/** When it was deprecated, as RFC 9745's `Deprecation` date (2026-10-07). */
const MULTIPART_DEPRECATED_AT = Date.UTC(2026, 9, 7) / 1000

const DEPRECATION_HEADERS = {
  deprecation: `@${MULTIPART_DEPRECATED_AT}`,
  link: '<https://github.com/Anonify-v2-0/Anonify2.0/blob/main/docs/api.md#put-apiuploadlocal>; rel="deprecation"; type="text/markdown"',
}

/**
 * What a browser says when it is here because a presigned PUT failed (#185).
 * Only these values are logged; anything else in the header is ignored.
 */
const FALLBACK_REASONS = new Set(["presigned-network-error"])

/** Why a streamed body was not the length it declared. */
class UploadLengthError extends Error {
  constructor(readonly kind: "long" | "short") {
    super(
      kind === "long"
        ? "The upload is longer than its Content-Length"
        : "The upload ended before its Content-Length"
    )
    this.name = "UploadLengthError"
  }
}

/**
 * Passes exactly `declared` bytes and fails otherwise.
 *
 * Failing is what keeps a partial upload out of storage: every driver writes
 * nothing under the final key when its source stream errors. The local disk
 * writes beside the destination and renames, S3 aborts the multipart upload,
 * and Azure never commits the block list. A body that just stops (a client
 * that went away) ends short and is failed in `flush`, before it would count
 * as complete.
 */
function lengthGuard(declared: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length
      if (seen > declared) callback(new UploadLengthError("long"))
      else callback(null, chunk)
    },
    flush(callback) {
      callback(seen === declared ? null : new UploadLengthError("short"))
    },
  })
}

/** A Content-Length that is a whole number of bytes, or null. */
function declaredLength(header: string | null): number | null {
  if (header === null || !/^\d{1,15}$/.test(header.trim())) return null
  return Number(header.trim())
}

type Owned =
  | {
      ok: true
      document: { id: string; originalName: string; uploadFormat: unknown }
    }
  | { ok: false; response: Response }

/**
 * The document, if the caller owns it and it is waiting for its bytes, with
 * the size checked against the plaintext ceiling. The same checks the Vercel
 * token route makes before signing.
 */
async function ownedUpload(
  documentId: string,
  ownerKey: string | undefined,
  size: number
): Promise<Owned> {
  const refuse = (message: string, status: number): Owned => ({
    ok: false,
    response: errorResponse(message, status),
  })

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

  if (!document || document.userFingerprint !== ownerKey) {
    return refuse("Document not found", 404)
  }
  if (document.status !== "uploading") {
    return refuse("This document has already been uploaded", 409)
  }

  // The ceiling is on the plaintext. A sealed upload is larger than its file
  // by its header and tags, and a size no sealer produces is refused here
  // rather than stored and failed at ingest.
  const plaintextSize = uploadFormatOf(document.uploadFormat)
    ? sealedUploadPlaintextBytes(size)
    : size
  if (plaintextSize === null) return refuse("Upload is not a sealed file", 400)
  if (plaintextSize === 0) return refuse("File is empty", 400)
  if (plaintextSize > MAX_UPLOAD_BYTES) return refuse("File is too large", 413)

  return { ok: true, document }
}

/**
 * Recorded here, by the code that wrote it, rather than taken from the client
 * when it calls /process — and so the expiry sweep can find the upload even
 * if that call never comes.
 */
async function recordUpload(documentId: string, key: string): Promise<void> {
  await prisma.document.updateMany({
    where: { id: documentId, status: "uploading" },
    data: { uploadBlobKey: key },
  })
}

/**
 * `PUT /api/upload/local?documentId=…`, the body the upload itself.
 *
 * Everything is decided before a byte of the body is read: who is asking,
 * whether the document is theirs and still waiting, and whether the declared
 * length is one the ceiling allows. A refusal never reads the body, so a
 * client sending 50 MiB at someone else's document costs a database read.
 */
export async function PUT(request: Request) {
  try {
    const identity = await peekIdentity()

    const limit = await consumeRateLimit(
      "upload",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) return rateLimitResponse(limit, "uploads")

    const documentId =
      new URL(request.url).searchParams.get("documentId")?.trim() ?? ""
    if (!documentId) return errorResponse("Missing document reference", 400)

    const declared = declaredLength(request.headers.get("content-length"))
    if (declared === null) {
      return errorResponse("The upload needs a Content-Length", 411)
    }
    if (declared === 0) return errorResponse("File is empty", 400)
    if (declared > maxSealedUploadBytes()) {
      return errorResponse("File is too large", 413)
    }
    const contentType = request.headers.get("content-type")
    if (
      contentType &&
      !/^application\/octet-stream\s*(;|$)/i.test(contentType.trim())
    ) {
      return errorResponse("Send the file as application/octet-stream", 415)
    }

    const owned = await ownedUpload(documentId, identity?.ownerKey, declared)
    if (!owned.ok) return owned.response
    const { document } = owned
    if (!request.body) return errorResponse("File is empty", 400)

    const fallback = request.headers.get("x-anonify-upload-fallback")
    if (fallback && FALLBACK_REASONS.has(fallback)) {
      // A browser whose PUT straight to the bucket failed before it got an
      // answer: CORS, almost always. Said here, because otherwise the only
      // record of a misconfigured bucket is in users' consoles.
      console.warn(
        JSON.stringify({
          level: "warn",
          context: "upload.presigned-fallback",
          reason: fallback,
          origin: request.headers.get("origin")?.slice(0, 200) ?? null,
          message:
            'A browser could not upload straight to the bucket and fell back to the app. Check the bucket\'s CORS rule allows PUT from this origin with the headers the upload is signed with (docs/storage.md, "Direct uploads").',
        })
      )
    }

    const guard = lengthGuard(declared)
    const source = Readable.fromWeb(
      request.body as WebReadableStream<Uint8Array>
    )
    // A client that went away, rather than storage that failed.
    let disconnected = false
    source.once("error", () => {
      disconnected = true
    })
    // Errors from either end reach the guard, which is what the driver reads.
    const body = pipeline(source, guard, () => {})

    let stored: Awaited<ReturnType<typeof putObjectStream>>
    try {
      stored = await putObjectStream(
        uploadKey(document.id, document.originalName),
        body
      )
    } catch (error) {
      if (error instanceof UploadLengthError && error.kind === "long") {
        return errorResponse("File is too large", 413)
      }
      if (error instanceof UploadLengthError || disconnected) {
        return errorResponse("The upload was incomplete. Try again.", 400)
      }
      throw error
    }

    await recordUpload(document.id, stored.key)
    return jsonResponse({ url: stored.key, size: stored.size }, 201)
  } catch (error) {
    return handleRouteError(error, "upload.local")
  }
}

let lastDeprecationLog = -Infinity

/**
 * `POST`, multipart: deprecated, and removed in 1.17.0. `request.formData()`
 * holds the whole file in memory before any of it is written, which is the
 * cost `PUT` exists to remove. Every answer carries `Deprecation` and a link
 * to what replaces it, and the process logs it at most once an hour.
 */
export async function POST(request: Request) {
  const response = await multipart(request)
  for (const [name, value] of Object.entries(DEPRECATION_HEADERS))
    response.headers.set(name, value)

  if (Date.now() - lastDeprecationLog > 60 * 60 * 1000) {
    lastDeprecationLog = Date.now()
    console.warn(
      JSON.stringify({
        level: "warn",
        context: "upload.local.deprecated",
        message: `POST /api/upload/local with a multipart body is deprecated and is removed in ${MULTIPART_REMOVED_IN}. PUT the file as the body, with ?documentId= and a Content-Length (docs/api.md).`,
      })
    )
  }
  return response
}

async function multipart(request: Request): Promise<Response> {
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
    // Nothing is either format's ceiling past the larger of the two; the
    // exact check needs the row, and this one does not.
    if (file.size > maxSealedUploadBytes()) {
      return errorResponse("File is too large", 413)
    }

    const owned = await ownedUpload(documentId, identity?.ownerKey, file.size)
    if (!owned.ok) return owned.response
    const { document } = owned

    // Sealed or not, the bytes are stored exactly as they arrived: sealing
    // happened in the browser, and opening is ingest's job.
    const stored = await putObjectStream(
      uploadKey(document.id, document.originalName),
      Readable.fromWeb(file.stream() as WebReadableStream<Uint8Array>)
    )

    await recordUpload(document.id, stored.key)
    return jsonResponse({ url: stored.key, size: stored.size }, 201)
  } catch (error) {
    return handleRouteError(error, "upload.local")
  }
}
