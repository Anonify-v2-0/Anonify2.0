import type { DocumentKind, TtlOption } from "@/types/document"

/** Hard upload ceiling. Anything larger is rejected before it is buffered. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const ACCEPTED_MIME_TYPES: Record<string, DocumentKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
}

export const ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
] as const

export const ALLOWED_TTL_SECONDS: TtlOption[] = [3600, 21600, 86400, 259200]

/**
 * The hard ceiling on an anonymous demo document's life, measured from when it
 * was created. Extending raises the window towards this limit; it never resets
 * the clock, so a document cannot be kept alive by renewing it repeatedly.
 */
export const MAX_RETENTION_SECONDS = 72 * 60 * 60

/** Anonymous demo quotas, enforced server-side per fingerprint per day. */
export const DAILY_QUOTA = {
  pdfPages: 10,
  docxPages: 10,
  xlsxCells: 100 * 100,
  images: 3,
  uploads: 20,
}

export const RATE_LIMITS = {
  upload: { limit: 10, windowSeconds: 60 },
  processing: { limit: 30, windowSeconds: 60 },
  export: { limit: 10, windowSeconds: 60 },
  read: { limit: 240, windowSeconds: 60 },
} as const

export type RateLimitName = keyof typeof RATE_LIMITS

export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
