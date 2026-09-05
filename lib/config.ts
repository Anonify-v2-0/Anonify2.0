import type { TtlOption } from "@/types/document"

/**
 * Hard upload ceiling. Anything larger is rejected before it is buffered.
 *
 * Raised from 25 MiB to 50 MiB alongside the wider format list — a deck with
 * images in it, or a mailbox export with attachments, is routinely larger than
 * 25 MiB and was being refused for a reason that had nothing to do with what
 * the pipeline can actually handle.
 *
 * What makes the larger number safe is that it was never the thing bounding
 * the work. Every path here holds one document in memory at a time — the
 * upload route buffers it, ingest seals it, the extractor reads it — so the
 * cost is linear in this number and the concurrency is bounded by the rate
 * limiter above it. What is *not* linear in the file size is parsing, and each
 * format bounds that itself rather than relying on this: the email parser caps
 * MIME depth, part count and decoded text; the text pipelines cap characters;
 * the delimited pipeline caps rows and columns; the workbook reader caps rows
 * and columns. A 50 MiB file that expands into something pathological is
 * refused by the format that would have to read it, which is where the refusal
 * belongs — raising an upload ceiling must never be the same decision as
 * allowing unlimited complexity.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

// What a format is — its MIME types, its extensions, its quota, whether it is
// a package — lives in one place, lib/documents/formats.ts. These are the
// derived allow-lists, re-exported here because that is where callers have
// always looked for them.
export {
  ACCEPTED_EXTENSIONS,
  ACCEPTED_MIME_TYPES,
  supportedFormatsSentence,
} from "@/lib/documents/formats"

/**
 * How many documents one batch may hold.
 *
 * It bounds two different things that now meet. A reviewer dragging files in
 * is bounded here because one request should stay one request; a message being
 * expanded into a batch is bounded by the same number for a stronger reason —
 * a stranger chooses how many attachments a message carries, and the expansion
 * limits in lib/documents/eml/attachments.ts default to this so the two cannot
 * drift into disagreeing about what a batch is.
 */
export const MAX_BATCH_FILES = 20

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
