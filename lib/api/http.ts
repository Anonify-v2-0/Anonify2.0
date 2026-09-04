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
