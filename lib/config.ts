import type { TtlOption } from "@/types/document"

/** Hard upload ceiling. Anything larger is rejected before it is buffered. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

// What a format is — its MIME types, its extensions, its quota, whether it is
// a package — lives in one place, lib/documents/formats.ts. These are the
// derived allow-lists, re-exported here because that is where callers have
// always looked for them.
export {
  ACCEPTED_EXTENSIONS,
  ACCEPTED_MIME_TYPES,
  supportedFormatsSentence,
} from "@/lib/documents/formats"

export const ALLOWED_TTL_SECONDS: TtlOption[] = [3600, 21600, 86400, 259200]

/**
 * The hard ceiling on an anonymous demo document's life, measured from when it
 * was created. Extending raises the window towards this limit; it never resets
 * the clock, so a document cannot be kept alive by renewing it repeatedly.
 */
export const MAX_RETENTION_SECONDS = 72 * 60 * 60

// Quotas live in lib/security/quota-config.ts and rate limits in
// lib/security/rate-limit-config.ts. Both differ by deployment profile — the
// demo rations a shared endpoint, a self-hosted install has nobody to ration
// against — so neither belongs here as a constant.
export type { RateLimitName } from "@/lib/security/rate-limit-config"
export type { UsageKind } from "@/lib/security/quota-config"

export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
