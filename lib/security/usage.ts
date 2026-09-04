import { prisma } from "@/lib/database/prisma"
import { newUsageId } from "@/lib/documents/ids"
import {
  effectiveQuotas,
  isUnlimited,
  USAGE_KINDS,
  type UsageKind,
} from "@/lib/security/quota-config"
import type { DocumentKind } from "@/types/document"

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
    xlsxCells: "spreadsheet cells",
    images: "images",
    uploads: "uploads",
  }

  return `Daily demo limit reached for ${labels[check.kind]} (${check.limit}). It resets at midnight UTC.`
}
