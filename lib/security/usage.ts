import { DAILY_QUOTA } from "@/lib/config"
import { prisma } from "@/lib/database/prisma"
import { newUsageId } from "@/lib/documents/ids"
import type { DocumentKind } from "@/types/document"

/**
 * Anonymous demo quotas.
 *
 * Enforced server-side, keyed by a hashed identifier, and counted in the
 * database — never in Redux, never in localStorage. A quota a client can edit
 * is not a quota.
 */

export type UsageKind = "pdfPages" | "docxPages" | "xlsxCells" | "images" | "uploads"

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
  switch (kind) {
    case "pdf":
      return "pdfPages"
    case "docx":
      return "docxPages"
    case "xlsx":
      return "xlsxCells"
    case "image":
      return "images"
  }
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
  const record = await currentUsage(fingerprint)
  const limit = DAILY_QUOTA[kind]
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

  const limit = DAILY_QUOTA[input.kind]
  const used = record[input.kind]

  return {
    allowed: used <= limit,
    kind: input.kind,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  }
}

export function quotaMessage(check: QuotaCheck): string {
  const labels: Record<UsageKind, string> = {
    pdfPages: "PDF pages",
    docxPages: "document pages",
    xlsxCells: "spreadsheet cells",
    images: "images",
    uploads: "uploads",
  }

  return `Daily demo limit reached for ${labels[check.kind]} (${check.limit}). It resets at midnight UTC.`
}
