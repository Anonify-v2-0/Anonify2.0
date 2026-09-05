import { createHmac, timingSafeEqual } from "node:crypto"

import { requiredEnv } from "@/lib/config"

/**
 * Short-lived download authorization.
 *
 * The stored artifact is never exposed by its storage URL. A download is
 * authorized by a token that names the document, the artifact and an expiry,
 * signed server-side — so a link cannot be edited into one for another
 * document, and it stops working on its own.
 */

const DEFAULT_TTL_SECONDS = 300

function sign(payload: string, domain = "download-url|"): string {
  // Domain-separated so a download token can never be confused with any other
  // value derived from the same secret — including a batch token, which
  // authorizes a whole archive rather than one artifact.
  return createHmac("sha256", requiredEnv("FINGERPRINT_SECRET"))
    .update(domain)
    .update(payload)
    .digest("base64url")
}

const BATCH_DOMAIN = "batch-download-url|"

function encode(payload: string, domain?: string): string {
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload, domain)}`
}

/** The signed half of a token, verified without interpreting the payload. */
function decode(token: string, domain?: string): string | null {
  const separator = token.lastIndexOf(".")
  if (separator === -1) return null

  const encoded = token.slice(0, separator)
  const signature = token.slice(separator + 1)

  let payload: string
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8")
  } catch {
    return null
  }

  const expected = Buffer.from(sign(payload, domain))
  const provided = Buffer.from(signature)
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return null
  }

  return payload
}

export function createDownloadToken(input: {
  documentId: string
  artifactId: string
  ownerKey: string
  ttlSeconds?: number
}): string {
  const expiresAt =
    Date.now() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000
  const payload = [
    input.documentId,
    input.artifactId,
    input.ownerKey,
    String(expiresAt),
  ].join(".")

  return encode(payload)
}

export type VerifiedToken = {
  documentId: string
  artifactId: string
  ownerKey: string
  expiresAt: number
}

export function verifyDownloadToken(token: string): VerifiedToken | null {
  const payload = decode(token)
  if (!payload) return null

  const [documentId, artifactId, ownerKey, expiresAt] = payload.split(".")
  if (!documentId || !artifactId || !ownerKey || !expiresAt) return null
  if (Number(expiresAt) <= Date.now()) return null

  return {
    documentId,
    artifactId,
    ownerKey,
    expiresAt: Number(expiresAt),
  }
}

/**
 * The same short-lived authorization for a batch archive.
 *
 * A separate signing domain rather than a document token with a batch id in it:
 * the two grant different things, and a token that could be reinterpreted as
 * the other is the kind of mistake that only shows up once somebody tries.
 */
export function createBatchToken(input: {
  batchId: string
  ownerKey: string
  ttlSeconds?: number
}): string {
  const expiresAt =
    Date.now() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000
  const payload = [input.batchId, input.ownerKey, String(expiresAt)].join(".")

  return encode(payload, BATCH_DOMAIN)
}

export type VerifiedBatchToken = {
  batchId: string
  ownerKey: string
  expiresAt: number
}

export function verifyBatchToken(token: string): VerifiedBatchToken | null {
  const payload = decode(token, BATCH_DOMAIN)
  if (!payload) return null

  const [batchId, ownerKey, expiresAt] = payload.split(".")
  if (!batchId || !ownerKey || !expiresAt) return null
  if (Number(expiresAt) <= Date.now()) return null

  return { batchId, ownerKey, expiresAt: Number(expiresAt) }
}
