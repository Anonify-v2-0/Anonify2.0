import type { UsageKind } from "@/lib/security/quota-config"
import type { RateLimitName } from "@/lib/security/rate-limit-config"

/**
 * What the caller is allowed to do, and how much of it they have done.
 *
 * Two different things, deliberately reported side by side. A rate limit is
 * about pace — requests per minute, refilling continuously — and a quota is
 * about volume for the day. Hitting either produces the same "too many"
 * response, so a panel that shows only one of them leaves the user guessing
 * which wall they walked into.
 */

export type RateLimitStatus = {
  name: RateLimitName
  /** Requests permitted in a burst. */
  limit: number
  windowSeconds: number
  remaining: number
  /** Present only while the bucket is empty. */
  resetAt: string | null
}

export type QuotaStatus = {
  kind: UsageKind
  used: number
  /** 0 means unlimited, which is the self-hosted default. */
  limit: number
}

export type LimitsReport = {
  profile: string
  rateLimits: RateLimitStatus[]
  quotas: QuotaStatus[]
}

export const RATE_LIMIT_LABELS: Record<RateLimitName, string> = {
  upload: "Uploads",
  processing: "Processing",
  export: "Exports",
  read: "Reads",
}

export const QUOTA_LABELS: Record<UsageKind, string> = {
  pdfPages: "PDF pages",
  docxPages: "Document pages",
  // Workbooks, CSV and TSV all count cells, so the label cannot say Excel.
  xlsxCells: "Table cells",
  images: "Images",
  textPages: "Text pages",
  emailKilobytes: "Email content (KiB)",
  pptxSlides: "Slides",
  uploads: "Uploads",
}

/** Share of an allowance consumed, 0-1. Unlimited allowances have no share. */
export function usedFraction(used: number, limit: number): number | null {
  if (limit <= 0) return null
  return Math.min(1, used / limit)
}
