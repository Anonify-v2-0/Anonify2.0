/**
 * Layer C: the redaction model. This — not invisible markers inside the
 * document bytes — is the source of truth for what gets removed on export.
 */

import type { BoundingBox } from "./document"

export const REDACTION_TYPES = [
  "text",
  "region",
  "face",
  "cell",
  "row",
  "column",
] as const

export type RedactionType = (typeof REDACTION_TYPES)[number]

export const REDACTION_SOURCES = ["ai", "user", "rule"] as const

export type RedactionSource = (typeof REDACTION_SOURCES)[number]

export const REDACTION_STATUSES = ["suggested", "accepted", "rejected"] as const

export type RedactionStatus = (typeof REDACTION_STATUSES)[number]

export const REDACTION_CATEGORIES = [
  "person",
  "address",
  "phone",
  "email",
  "government-id",
  "bank-account",
  "financial",
  "date-of-birth",
  "customer-id",
  "confidential",
  "api-key",
  "url",
  "face",
  "other",
] as const

export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number]

export type Redaction = {
  id: string
  documentId: string
  type: RedactionType
  source: RedactionSource
  category: string
  confidence?: number
  status: RedactionStatus

  /** 1-based page number for page-oriented documents. */
  page?: number
  /** The exact source text this redaction covers. */
  text?: string
  /** Character offsets into the page's normalized text stream. */
  start?: number
  end?: number

  boundingBox?: BoundingBox

  worksheet?: string
  row?: number
  column?: number

  /** Short model- or rule-supplied justification shown in the inspector. */
  reason?: string
  ruleId?: string
  metadata?: Record<string, unknown>
}

export type GlobalRule = {
  id: string
  documentId: string
  /** The literal value the rule matches, as typed by the user or detector. */
  pattern: string
  /** Case/whitespace-folded form used for local matching. */
  normalizedPattern: string
  category: string
  enabled: boolean
  createdFromRedactionId?: string
}

export type ConfidenceBand = "high" | "medium" | "low"

export function confidenceBand(confidence: number | undefined): ConfidenceBand {
  if (confidence === undefined) return "medium"
  if (confidence >= 0.85) return "high"
  if (confidence >= 0.6) return "medium"
  return "low"
}

/** A detection is an AI/rule proposal before it becomes a Redaction. */
export type Detection = {
  text: string
  category: string
  confidence: number
  page?: number
  start?: number
  end?: number
  reason?: string
  global?: boolean
  boundingBox?: BoundingBox
  worksheet?: string
  row?: number
  column?: number
}
