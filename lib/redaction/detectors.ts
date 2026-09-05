import type { Detection } from "@/types/redaction"

/**
 * Deterministic detection.
 *
 * Patterns that can be recognized by shape are found here, before any model is
 * called: it is faster, free, reproducible, and it means the language model
 * only ever has to answer the genuinely contextual question — is this *person's
 * name* sensitive here? — rather than re-deriving that a string with an @ in it
 * is an email address.
 */

export type PatternDetector = {
  /**
   * Stable name for this detector, used by presets to turn it on or off. It is
   * not the category: two detectors can propose the same category — an IBAN and
   * a labelled account number are both `bank-account` — and a preset has to be
   * able to want one without the other.
   */
  id: string
  category: string
  /** Confidence for a bare pattern match, before any contextual check. */
  confidence: number
  pattern: RegExp
  /** Extra check for patterns that are cheap to match but easy to over-match. */
  validate?: (value: string, context: string, index: number) => boolean
  /** Whether a match should be proposed for redaction everywhere it occurs. */
  global?: boolean
  reason: string
}

/** Luhn check, so an order number is not reported as a payment card. */
export function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "")
  if (digits.length < 13 || digits.length > 19) return false

  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/** US Social Security numbers exclude several administratively invalid forms. */
export function plausibleSsn(value: string): boolean {
  const digits = value.replace(/\D/g, "")
  if (digits.length !== 9) return false
  const area = digits.slice(0, 3)
  const group = digits.slice(3, 5)
  const serial = digits.slice(5)
  return (
    area !== "000" &&
    area !== "666" &&
    Number(area) < 900 &&
    group !== "00" &&
    serial !== "0000"
  )
}

/** True when a label like "Account:" or "DOB" sits just before the match. */
function precededBy(context: string, index: number, labels: RegExp): boolean {
  const window = context.slice(Math.max(0, index - 40), index)
  return labels.test(window)
}

export const DETECTORS: PatternDetector[] = [
  {
    id: "email-address",
    category: "email",
    confidence: 0.97,
    global: true,
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    reason: "Matches an email address",
  },
  {
    id: "phone-number",
    category: "phone",
    confidence: 0.88,
    global: true,
    pattern:
      /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}\b/g,
    validate: (value) => value.replace(/\D/g, "").length >= 9,
    reason: "Matches a telephone number",
  },
  {
    id: "us-social-security",
    category: "government-id",
    confidence: 0.95,
    global: true,
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: (value) => plausibleSsn(value),
    reason: "Matches a Social Security number",
  },
  {
    id: "payment-card",
    category: "financial",
    confidence: 0.94,
    global: true,
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: (value) => passesLuhn(value),
    reason: "Passes the Luhn check for a payment card number",
  },
  {
    id: "iban",
    category: "bank-account",
    confidence: 0.93,
    global: true,
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    reason: "Matches an IBAN",
  },
  {
    id: "labelled-account-number",
    category: "bank-account",
    confidence: 0.7,
    global: true,
    pattern: /\b\d{8,17}\b/g,
    validate: (value, context, index) =>
      precededBy(context, index, /(account|acct|iban|sort\s*code)\b[^\n]{0,12}$/i),
    reason: "A long number labelled as an account",
  },
  {
    id: "credential",
    category: "api-key",
    confidence: 0.96,
    global: true,
    pattern:
      /\b(?:sk|pk|rk)[-_](?:live|test|prod)?[-_]?[A-Za-z0-9]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b/g,
    reason: "Matches a credential or API key format",
  },
  {
    id: "labelled-date-of-birth",
    category: "date-of-birth",
    confidence: 0.72,
    pattern:
      /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/g,
    validate: (_value, context, index) =>
      precededBy(context, index, /(d\.?o\.?b|date of birth|born|birth\s*date)[^\n]{0,12}$/i),
    reason: "A date labelled as a date of birth",
  },
  {
    id: "labelled-reference",
    category: "customer-id",
    confidence: 0.68,
    pattern: /\b[A-Z]{2,5}-?\d{4,10}\b/g,
    validate: (_value, context, index) =>
      precededBy(
        context,
        index,
        /(customer|client|member|policy|reference|case|patient)\s*(id|no|number|#)?[^\n]{0,10}$/i
      ),
    reason: "An identifier labelled as a customer or case reference",
  },
  {
    id: "link-with-token",
    category: "url",
    confidence: 0.55,
    pattern: /\bhttps?:\/\/[^\s<>"')]+/gi,
    validate: (value) =>
      // Public documentation links are noise; anything with a query string,
      // a token-looking path or a non-public host is worth surfacing.
      /[?&](token|key|auth|session|id)=/i.test(value) ||
      /\/(share|invite|reset|verify)\//i.test(value),
    reason: "A URL carrying what looks like a token or a private link",
  },
  {
    id: "street-address",
    category: "address",
    confidence: 0.6,
    pattern:
      /\b\d{1,5}\s+[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Terrace|Place|Pl)\b\.?/g,
    reason: "Matches a street address",
  },
]

export type DetectorOptions = {
  page?: number
  worksheet?: string
  /** Offset added to every match position, for chunked input. */
  offset?: number
  /**
   * Detector ids to run. Absent means all of them — a preset narrows the sweep,
   * and the absence of a preset must never narrow it.
   */
  detectors?: readonly string[] | null
}

/**
 * Runs every deterministic detector over a block of text. Overlapping matches
 * are resolved in favour of the higher-confidence detector so a card number is
 * not also reported as a phone number.
 */
export function detectPatterns(
  text: string,
  options: DetectorOptions = {}
): Detection[] {
  const offset = options.offset ?? 0
  const found: Detection[] = []
  const enabled = options.detectors ? new Set(options.detectors) : null

  for (const detector of DETECTORS) {
    if (enabled && !enabled.has(detector.id)) continue

    // The detectors are module-level and carry the `g` flag; resetting keeps
    // repeated calls independent.
    detector.pattern.lastIndex = 0

    let match: RegExpExecArray | null
    while ((match = detector.pattern.exec(text)) !== null) {
      const value = match[0]
      if (value.trim().length === 0) continue
      if (detector.validate && !detector.validate(value, text, match.index)) {
        continue
      }

      found.push({
        text: value,
        category: detector.category,
        confidence: detector.confidence,
        start: match.index + offset,
        end: match.index + value.length + offset,
        reason: detector.reason,
        global: detector.global,
        page: options.page,
        worksheet: options.worksheet,
      })
    }
  }

  return resolveOverlaps(found)
}

/** Keeps the strongest detection when two of them cover the same characters. */
export function resolveOverlaps(detections: Detection[]): Detection[] {
  const ordered = [...detections].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    const aLength = (a.end ?? 0) - (a.start ?? 0)
    const bLength = (b.end ?? 0) - (b.start ?? 0)
    return bLength - aLength
  })

  const kept: Detection[] = []
  for (const detection of ordered) {
    const start = detection.start ?? 0
    const end = detection.end ?? 0
    const overlaps = kept.some((existing) => {
      if (existing.page !== detection.page) return false
      const otherStart = existing.start ?? 0
      const otherEnd = existing.end ?? 0
      return start < otherEnd && end > otherStart
    })
    if (!overlaps) kept.push(detection)
  }

  return kept.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
}
