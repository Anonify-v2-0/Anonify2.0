import { AccessError } from "@/lib/security/access-control"

/**
 * Reads a request body, treating a malformed one as a client error.
 *
 * `request.json()` and `request.formData()` throw on a body that is absent or
 * the wrong shape, and letting that reach the generic handler turns a bad
 * request into a 500 — which reads as "the server is broken" when it is not.
 */
export async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

export async function readFormData(
  request: Request
): Promise<FormData | undefined> {
  try {
    return await request.formData()
  } catch {
    return undefined
  }
}

/**
 * A file response, streamed rather than buffered.
 *
 * The bytes are already in memory by the time this is called — everything here
 * decrypts a whole object and verifies its checksum before serving it, and
 * cannot honestly stream something it has to hash in full first. What this
 * changes is the *response*, and on Vercel that is the difference between a
 * download working and not: a buffered response body is capped at 4.5 MB and
 * anything larger is refused by the platform with FUNCTION_PAYLOAD_TOO_LARGE
 * before a byte reaches the browser. A streamed body has no such cap. Since
 * this app's ceiling is MAX_UPLOAD_BYTES — 50 MiB — the buffered form was wrong
 * for almost every real document.
 *
 * `content-length` is deliberately absent. Setting it alongside a stream is
 * what makes some intermediaries treat the response as buffered again, which
 * reinstates the limit this exists to avoid; the cost is a progress bar the
 * browser cannot fill, which is the correct trade against a download that 413s.
 *
 * Chunked because a single 50 MiB enqueue is one buffered write wearing a
 * stream's clothes: it pins the whole object in the response queue at once,
 * which is the memory profile that matters on a 2 GB Hobby function.
 */
const STREAM_CHUNK_BYTES = 512 * 1024

export function fileResponse(
  bytes: Uint8Array,
  headers: Record<string, string>
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += STREAM_CHUNK_BYTES) {
        controller.enqueue(bytes.subarray(offset, offset + STREAM_CHUNK_BYTES))
      }
      controller.close()
    },
  })

  return new Response(body, { headers })
}

export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

export function errorResponse(message: string, status: number, extra?: Record<string, unknown>): Response {
  return jsonResponse({ error: message, ...extra }, status)
}

/**
 * The one shape a refused request takes.
 *
 * Every route used to phrase this itself, and each said only "too many" — true,
 * and useless, because the one thing the caller needs is when to come back.
 * That went out as an ISO timestamp nothing rendered. This carries the wait in
 * seconds, a sentence a person can act on, and the `Retry-After` header the
 * status code is supposed to come with.
 */
export function rateLimitResponse(
  limit: { resetAt: Date; remaining?: number },
  what: string
): Response {
  const seconds = Math.max(
    1,
    Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000)
  )

  return Response.json(
    {
      error: `Too many ${what}. Try again in ${describeWait(seconds)}.`,
      retryAfterSeconds: seconds,
      resetAt: limit.resetAt.toISOString(),
      rateLimited: true,
    },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(seconds),
      },
    }
  )
}

export function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.ceil(minutes / 60)
  return `${hours} hour${hours === 1 ? "" : "s"}`
}

/**
 * Maps thrown errors onto responses without ever leaking document content or
 * internal detail to the client.
 */
export function handleRouteError(error: unknown, context: string): Response {
  if (error instanceof AccessError) {
    return errorResponse(error.message, error.status)
  }

  const message = error instanceof Error ? error.message : String(error)
  console.error(
    JSON.stringify({ level: "error", context, errorCategory: categorize(message) })
  )

  if (/Missing required environment variable/.test(message)) {
    return errorResponse("Service is not configured", 503)
  }
  if (/DATABASE_URL/.test(message)) {
    return errorResponse("Storage backend unavailable", 503)
  }

  return errorResponse("Something went wrong", 500)
}

function categorize(message: string): string {
  if (/DATABASE_URL|connect|ECONNREFUSED/i.test(message)) return "database"
  if (/blob|fetch failed/i.test(message)) return "storage"
  if (/environment variable/i.test(message)) return "configuration"
  return "unexpected"
}
