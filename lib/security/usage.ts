import { prisma } from "@/lib/database/prisma"
import { quotaKindFor } from "@/lib/documents/formats"
import { newUsageId } from "@/lib/documents/ids"
import {
  effectiveQuotas,
  isUnlimited,
  USAGE_KINDS,
  type UsageKind,
} from "@/lib/security/quota-config"
import type { DocumentKind, NormalizedDocument } from "@/types/document"

/**
 * Quota accounting.
 *
 * Enforced server-side, keyed by a hashed identifier, and counted in the
 * database — never in Redux, never in localStorage. A quota a client can edit
 * is not a quota.
 *
 * How large the allowances are is a deployment question, not a code one:
 * lib/security/quota-config.ts resolves them from the profile and the
 * environment, and a self-hosted install has none.
 */

export type { UsageKind }

export type QuotaCheck = {
  allowed: boolean
  kind: UsageKind
  used: number
  limit: number
  remaining: number
}

/** Quota windows are calendar days in UTC, so they reset predictably. */
function today(): Date {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
}

export function usageKindFor(kind: DocumentKind): UsageKind {
  return quotaKindFor(kind)
}

/**
 * What one normalized document costs against its allowance.
 *
 * Cells that hold something, not the area of the used range. A sheet with
 * three filled columns and one stray value out in column AN has a used range
 * forty columns wide, and charging for that bounding box bills the blanks —
 * which are neither work to process nor anything to leak.
 */
export function usageQuantity(
  kind: UsageKind,
  model: NormalizedDocument
): number {
  switch (kind) {
    case "xlsxCells":
      return (model.sheets ?? []).reduce(
        (total, sheet) => total + sheet.cells.length,
        0
      )
    case "images":
    case "uploads":
      return 1
    case "emailKilobytes":
      // What was actually decoded and searched: every header, every text part,
      // every nested message. Rounded up, so a short email still costs one.
      return Math.max(1, Math.ceil(textBytes(model) / 1024))
    case "pptxSlides":
      // Notes, layouts and masters are processed with the slide they belong to
      // rather than charged separately; the deck's slide count is the cost.
      return slideCount(model) ?? model.pages.length
    default:
      return model.pages.length
  }
}

function textBytes(model: NormalizedDocument): number {
  const text = model.pages.map((page) => page.text).join("\n")
  return Buffer.byteLength(text, "utf8")
}

function slideCount(model: NormalizedDocument): number | null {
  const value = model.metadata?.slideCount
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

async function currentUsage(fingerprint: string) {
  const date = today()
  return prisma.usageRecord.upsert({
    where: { fingerprint_date: { fingerprint, date } },
    create: { id: newUsageId(), fingerprint, date },
    update: {},
  })
}

/** Reads the remaining allowance without consuming any of it. */
export async function checkQuota(
  fingerprint: string,
  kind: UsageKind,
  quantity = 1
): Promise<QuotaCheck> {
  const limit = effectiveQuotas()[kind]

  // Nothing to account for, and nothing to read: an unlimited quota does not
  // need a usage row created just to be ignored.
  if (isUnlimited(limit)) {
    return { allowed: true, kind, used: 0, limit: 0, remaining: Infinity }
  }

  const record = await currentUsage(fingerprint)
  const used = record[kind]

  return {
    allowed: used + quantity <= limit,
    kind,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  }
}

/**
 * Records consumption. Returns the state after the increment so a caller that
 * only learns the true cost mid-processing (page count, cell count) can still
 * report an overrun.
 */
export async function recordUsage(input: {
  fingerprint: string
  kind: UsageKind
  quantity: number
}): Promise<QuotaCheck> {
  const date = today()
  const record = await prisma.usageRecord.upsert({
    where: { fingerprint_date: { fingerprint: input.fingerprint, date } },
    create: {
      id: newUsageId(),
      fingerprint: input.fingerprint,
      date,
      [input.kind]: input.quantity,
    },
    update: { [input.kind]: { increment: input.quantity } },
  })

  const limit = effectiveQuotas()[input.kind]
  const used = record[input.kind]

  // Usage is still recorded when unlimited — the numbers are what the usage
  // panel reports, and turning the limit off should not blind the counter.
  if (isUnlimited(limit)) {
    return { allowed: true, kind: input.kind, used, limit: 0, remaining: Infinity }
  }

  return {
    allowed: used <= limit,
    kind: input.kind,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  }
}

/**
 * Everything charged today against one identity, for the panel that reports it.
 *
 * Reads rather than upserts: asking how much you have used should not create a
 * row saying you have used nothing. And it reports the real counts even where
 * the limit is unlimited — turning a limit off is a reason to stop refusing
 * work, not a reason to stop counting it.
 */
export async function usageSnapshot(
  fingerprint: string | undefined
): Promise<{ kind: UsageKind; used: number; limit: number }[]> {
  const quotas = effectiveQuotas()

  const record = fingerprint
    ? await prisma.usageRecord.findUnique({
        where: { fingerprint_date: { fingerprint, date: today() } },
      })
    : null

  return USAGE_KINDS.map((kind) => ({
    kind,
    used: record?.[kind] ?? 0,
    limit: quotas[kind],
  }))
}

export function quotaMessage(check: QuotaCheck): string {
  const labels: Record<UsageKind, string> = {
    pdfPages: "PDF pages",
    docxPages: "document pages",
    xlsxCells: "table cells",
    images: "images",
    textPages: "text pages",
    emailKilobytes: "kibibytes of email content",
    pptxSlides: "slides",
    uploads: "uploads",
  }

  return `Daily demo limit reached for ${labels[check.kind]} (${check.limit}). It resets at midnight UTC.`
}

/**
 * Charges a document's allowance, at most once.
 *
 * The record of having charged lives in the document's own metadata. The
 * extraction step is retried — a storage blip, a cold worker — and it
 * re-extracts from scratch each time, so without this a document that failed
 * after charging and succeeded on the next attempt was billed twice for one
 * upload. Nothing in the workflow runtime prevents that: a step's result is
 * persisted when it succeeds, and the charge happens before it returns.
 *
 * The mark is written after the charge rather than before, deliberately. The
 * two orders fail differently: marking first and then failing means a document
 * that was never charged and never will be, and marking second means a charge
 * that could in principle be repeated. The second failure needs two database
 * writes on one connection to disagree, and the first is a quota that quietly
 * stops counting — which is the one that matters, because a quota nobody is
 * charged against is not a quota.
 */
export async function chargeDocumentUsage(input: {
  documentId: string
  kind: DocumentKind
  quotaKey: string | null
  /** The document's current metadata column. */
  metadata: unknown
  model: NormalizedDocument
}): Promise<{ charged: boolean; quota: QuotaCheck | null }> {
  if (!input.quotaKey) return { charged: false, quota: null }
  if (asRecord(input.metadata)?.quotaCharged !== undefined) {
    return { charged: false, quota: null }
  }

  const kind = usageKindFor(input.kind)
  const quantity = usageQuantity(kind, input.model)

  const quota = await recordUsage({
    fingerprint: input.quotaKey,
    kind,
    quantity,
  })

  await prisma.document.update({
    where: { id: input.documentId },
    data: {
      metadata: {
        ...(asRecord(input.metadata) ?? {}),
        quotaCharged: { kind, quantity, at: new Date().toISOString() },
      },
    },
  })

  return { charged: true, quota }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
