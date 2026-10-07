import { createHash } from "node:crypto"

/**
 * A JSON answer that a poller already holding it gets back as a 304.
 *
 * The document list and the batch view ask for the same thing every few
 * seconds while a document is processing, and most of those answers are
 * identical to the last one. The tag is a hash of the exact body, so it
 * changes exactly when anything the view draws changes, and two owners can
 * never share one: the body is already scoped to the caller.
 *
 * It saves the transfer and the browser's parse and re-render, not the
 * queries. A cheaper check before them would need a timestamp on everything
 * the view counts, and redactions have none: a list that answered 304 while a
 * redaction count moved would be wrong in a way nobody would notice.
 *
 * Callers check identity and ownership first, as they would for a 200.
 */
export function conditionalJsonResponse(
  request: Request,
  data: unknown
): Response {
  const body = JSON.stringify(data)
  const tag = etagOf(body)
  const headers = {
    etag: tag,
    // Not cached anywhere: the list names the caller's files. The client
    // keeps the tag itself and asks with it.
    "cache-control": "no-store",
  }

  if (matches(request.headers.get("if-none-match"), tag)) {
    return new Response(null, { status: 304, headers })
  }

  return new Response(body, {
    headers: { ...headers, "content-type": "application/json" },
  })
}

function etagOf(body: string): string {
  const digest = createHash("sha256").update(body).digest("base64url")
  return `W/"${digest.slice(0, 27)}"`
}

/** Weak comparison, as RFC 9110 §13.1.2 has it for `If-None-Match`. */
function matches(header: string | null, tag: string): boolean {
  if (!header) return false
  const opaque = stripWeak(tag)
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || stripWeak(candidate) === opaque)
}

function stripWeak(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag
}
