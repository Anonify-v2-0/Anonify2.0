import { activeProfile, type Profile } from "@/lib/security/rate-limit-config"

/**
 * Daily quotas, by deployment profile.
 *
 * These began as constants shared by every install, which meant a self-hosted
 * Anonify — your machine, your database, your documents — refused an ordinary
 * 800-row spreadsheet because a shared anonymous demo could not afford one.
 * The demo's allowances are a property of the demo, not of the software.
 *
 * Two layers, the same shape rate limits use:
 *
 *   defaults  → chosen by deployment profile
 *   env       → ANONIFY_QUOTA_<KIND>, for Docker Compose and hosting
 *
 * `0` means unlimited, which is the self-hosted default. Nothing here is a
 * security boundary: quotas exist so one anonymous visitor cannot spend the
 * demo's whole budget, and they are always enforced server-side against the
 * database — see lib/security/usage.ts.
 */

export const USAGE_KINDS = [
  "pdfPages",
  "docxPages",
  "xlsxCells",
  "images",
  "textPages",
  "emailKilobytes",
  "pptxSlides",
  "uploads",
] as const

export type UsageKind = (typeof USAGE_KINDS)[number]

/** Per-fingerprint, per-UTC-day. `0` is unlimited. */
export type Quotas = Record<UsageKind, number>

/** A shared anonymous demo, where one visitor's workbook is everyone's budget. */
const DEMO_DEFAULTS: Quotas = {
  pdfPages: 10,
  docxPages: 10,
  // Shared by every grid: a workbook, a CSV and a TSV cost the same per cell.
  xlsxCells: 100 * 100,
  images: 3,
  // Pages of extracted text, for plain text and RTF. Cheap to process, so the
  // allowance is larger than the page-image formats'.
  textPages: 40,
  // Kibibytes of decoded text pulled out of a message — headers, every text
  // part, and every nested message. An email is not a page and counting it as
  // one would charge a one-line reply the same as a forwarded thread.
  emailKilobytes: 512,
  pptxSlides: 20,
  uploads: 20,
}

/**
 * Your own machine. There is nobody to ration against, and a limit here is
 * indistinguishable from the application being broken: the failure arrives as
 * "processing failed" on a file that is in no way unusual.
 */
const SELF_HOSTED_DEFAULTS: Quotas = {
  pdfPages: 0,
  docxPages: 0,
  xlsxCells: 0,
  images: 0,
  textPages: 0,
  emailKilobytes: 0,
  pptxSlides: 0,
  uploads: 0,
}

export function defaultsFor(profile: Profile): Quotas {
  return { ...(profile === "demo" ? DEMO_DEFAULTS : SELF_HOSTED_DEFAULTS) }
}

/** ANONIFY_QUOTA_XLSX_CELLS, ANONIFY_QUOTA_PDF_PAGES, … */
export function envName(kind: UsageKind): string {
  return `ANONIFY_QUOTA_${kind.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`
}

/**
 * A malformed value is reported rather than ignored, for the same reason the
 * rate limiter reports one: a quota someone believes they set and which is not
 * in force is worse than no setting at all.
 */
export function envOverrides(): Partial<Quotas> {
  const overrides: Partial<Quotas> = {}

  for (const kind of USAGE_KINDS) {
    const raw = process.env[envName(kind)]?.trim()
    if (!raw) continue

    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `${envName(kind)} must be a whole number (0 for unlimited), got "${raw}"`
      )
    }
    overrides[kind] = Number(raw)
  }

  return overrides
}

export function resolveQuotas(
  profile: Profile,
  env: Partial<Quotas>
): Quotas {
  return { ...defaultsFor(profile), ...env }
}

export function effectiveQuotas(): Quotas {
  return resolveQuotas(activeProfile(), envOverrides())
}

export function isUnlimited(limit: number): boolean {
  return limit <= 0
}
