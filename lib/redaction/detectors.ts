import {
  LABELS,
  MONTHS,
  type Language,
  type LabelVocabulary,
} from "@/lib/redaction/languages"
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
  /**
   * More shapes for a document in one language, run as well as `pattern`.
   * A street is written number-first in French and name-first in German, and
   * no single expression reads both without matching half of everything.
   */
  patterns?: Partial<Record<Language, RegExp>>
  /**
   * The languages this detector runs for. Absent means every language. For
   * one country's identity number, whose check digit passes by chance often
   * enough that it is only worth trying where that country is likely.
   */
  languages?: readonly Language[]
  /**
   * Extra check for patterns that are cheap to match but easy to over-match.
   * `languages` are the ones the document may be in; see `DetectorOptions`.
   */
  validate?: (
    value: string,
    context: string,
    index: number,
    languages: readonly Language[]
  ) => boolean
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

/** An IBAN's check digits (ISO 13616: the number, mod 97, is 1). */
export function passesIbanCheck(value: string): boolean {
  const compact = value.replace(/\s/g, "").toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let remainder = 0
  for (const char of rearranged) {
    const code = char.charCodeAt(0)
    const digits = code >= 65 ? String(code - 55) : char
    for (const digit of digits)
      remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

/** Spanish DNI or NIE: the letter is the number mod 23. */
export function passesDniCheck(value: string): boolean {
  const match = /^([XYZ]?)(\d{7,8})-?([A-Z])$/.exec(value.toUpperCase())
  if (!match) return false
  const [, prefix, digits, letter] = match
  if (digits.length !== (prefix ? 7 : 8)) return false
  const number = Number(`${prefix ? "XYZ".indexOf(prefix) : ""}${digits}`)
  return "TRWAGMYFPDXBNJZSQVHLCKE"[number % 23] === letter
}

/** French NIR, the social security number: the key is 97 minus the rest mod 97. */
export function passesNirCheck(value: string): boolean {
  const compact = value.replace(/\s/g, "").toUpperCase()
  if (!/^[12]\d{4}(?:\d{2}|2A|2B)\d{8}$/.test(compact)) return false
  // Corsica's departments are 2A and 2B, read as 19 and 18 for the key.
  const body = compact.slice(0, 13).replace("2A", "19").replace("2B", "18")
  const key = 97 - Number(BigInt(body) % BigInt(97))
  return key === Number(compact.slice(13))
}

/** German Steuer-ID: the last digit is ISO 7064 MOD 11,10 over the first ten. */
export function passesSteuerIdCheck(value: string): boolean {
  const digits = value.replace(/\s/g, "")
  if (!/^[1-9]\d{10}$/.test(digits)) return false
  let product = 10
  for (const digit of digits.slice(0, 10)) {
    let sum = (Number(digit) + product) % 10
    if (sum === 0) sum = 10
    product = (sum * 2) % 11
  }
  const check = 11 - product
  return (check === 10 ? 0 : check) === Number(digits[10])
}

/** True when a label like "Account:" or "DOB" sits just before the match. */
function precededBy(
  context: string,
  index: number,
  labels: RegExp,
  reach = 40
): boolean {
  const window = context.slice(Math.max(0, index - reach), index)
  return labels.test(window)
}

/**
 * English labels, exactly as the detectors have always had them. They run for
 * every document: a German letter with an "IBAN:" line is still German.
 */
const ENGLISH_LABELS: Record<keyof LabelVocabulary, RegExp | null> = {
  birthDate: /(d\.?o\.?b|date of birth|born|birth\s*date)[^\n]{0,12}$/i,
  account: /(account|acct|iban|sort\s*code)\b[^\n]{0,12}$/i,
  reference:
    /(customer|client|member|policy|reference|case|patient)\s*(id|no|number|#)?[^\n]{0,10}$/i,
  identity: null,
}

/**
 * A label in the document's own language.
 *
 * It may sit further from the value than an English one, because these
 * languages put more words between: "Fecha de nacimiento consignada en el
 * expediente: 14/03/1991", "Steuer-ID von Mara: 36 388 113 508". Nothing
 * between may be a digit, so a label cannot reach past one value to the next.
 */
const localLabels = new Map<string, RegExp>()

function localLabel(
  kind: keyof LabelVocabulary,
  language: Exclude<Language, "en">
): RegExp {
  const key = `${language}:${kind}`
  let regex = localLabels.get(key)
  if (!regex) {
    regex = new RegExp(
      String.raw`(?<!\p{L})(?:${LABELS[language][kind]})(?!\p{L})[^\n\d]{0,30}$`,
      "iu"
    )
    localLabels.set(key, regex)
  }
  return regex
}

function labelledBy(
  kind: keyof LabelVocabulary,
  context: string,
  index: number,
  languages: readonly Language[]
): boolean {
  const english = ENGLISH_LABELS[kind]
  if (english && precededBy(context, index, english)) return true
  return languages.some(
    (language) =>
      language !== "en" &&
      precededBy(context, index, localLabel(kind, language), 64)
  )
}

const MONTH_NAMES = Object.values(MONTHS).flat().join("|")

// The letters names and cities are spelled with in these languages. Spelled
// out rather than \p{L}, because the `u` flag that \p{L} needs would also
// change what \b means in the rest of the pattern.
const UPPER = "A-ZÀ-ÖØ-Þ"
const LETTER = "A-Za-zÀ-ÖØ-öø-ÿ"
const NAME = `[${UPPER}][${LETTER}'’-]*`
const CITY = `[${UPPER}][${LETTER}'’.-]*(?:[ -](?:am |an der |sur |de |del |la )?[${UPPER}][${LETTER}'’.-]*){0,2}`

/** Streets, the way each language writes one, with the postcode and city when they follow. */
const STREETS: Partial<Record<Language, RegExp>> = {
  // Lindenstraße 27, 10969 Berlin · Am Mühlenbogen 17 · Berliner Str. 5a
  de: new RegExp(
    String.raw`(?:\b(?:Am|An der|Im|In der|Auf dem|Zum|Zur) )?(?<![${LETTER}])(?:[${UPPER}][a-zäöüß]+ (?:Straße|Strasse|Str\.|Weg|Allee|Platz|Ring|Damm|Ufer|Gasse|Chaussee)|[${UPPER}][a-zäöüß]+(?:-[${UPPER}][a-zäöüß]+)*(?:straße|strasse|str\.|weg|gasse|allee|platz|ring|damm|ufer|steig|stieg|chaussee|pfad|graben|kamp|rain|bogen)) \d{1,4}(?: ?[a-z]\b)?(?:,\s*\d{5}\s${CITY})?`,
    "g"
  ),
  // 18 rue des Alouettes, 44100 Nantes · 7, allée du Clos-Neuf
  fr: new RegExp(
    String.raw`\b\d{1,4}(?: ?(?:bis|ter))?,? (?:[Rr]ue|[Aa]venue|[Bb]oulevard|[Bb]d|[Pp]lace|[Cc]hemin|[Aa]llée|[Ii]mpasse|[Qq]uai|[Cc]ours|[Rr]oute|[Ss]quare|[Pp]assage) (?:(?:de la|de l['’]|des|du|de|d['’]) ?)?${NAME}(?: (?:(?:de la|des|du|de|d['’]|l['’]) ?)?${NAME}){0,3}(?:,?\s\d{5}\s${CITY})?`,
    "g"
  ),
  // Calle del Mirto 24, 3.º B, 28021 Madrid · plaza de la Encina, 8, bajo
  es: new RegExp(
    String.raw`\b(?:[Cc]alle|C\/|[Aa]venida|[Aa]vda\.|[Pp]aseo|[Pp]laza|[Pp]za\.|[Cc]amino|[Rr]onda|[Tt]ravesía|[Cc]arretera|[Gg]lorieta) (?:(?:de la|de los|de las|del|de) )?${NAME}(?: (?:(?:de la|de los|de las|del|de) )?${NAME}){0,3},? \d{1,4}(?:,? ?(?:\d{1,2}\.?\s?[ºª°](?: ?[A-Z]\b)?|bajo|entresuelo|ático))?(?:,\s\d{5}\s${CITY})?`,
    "g"
  ),
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
    // In order: French pairs (02 61 91 55 99, +33 1 99 00 15 77), a German
    // area code before a slash (040/66969201), an international number with
    // the trunk zero in brackets (+49 (0)40 66969 166), and the original shape.
    pattern:
      /(?:\+33[\s.]?|\b0)[1-9](?:[\s.]\d{2}){4}\b|\b0\d{2,4}\/\s?\d{4,9}\b|\+\d{1,3}\s?\(0\)\s?\d{2,4}[\s-]?\d{3,8}(?:[\s-]\d{1,5})?\b|(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}\b/g,
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
    // Written as one run, or in fours the way it is printed across Europe
    // (DE89 3704 0044 0532 0130 00). Every group after the first holds a
    // digit, so a capitalised word after the number is not read as its tail.
    pattern:
      /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|\s[A-Z0-9]{4}(?:\s(?=[A-Z]{0,3}\d)[A-Z0-9]{4}){1,6}(?:\s\d{1,3})?)\b/g,
    // A run is reported as it always was. Spaced groups are a looser shape,
    // so they have to carry valid check digits.
    validate: (value) => !/\s/.test(value) || passesIbanCheck(value),
    reason: "Matches an IBAN",
  },
  {
    id: "labelled-account-number",
    category: "bank-account",
    confidence: 0.7,
    global: true,
    pattern: /\b\d{8,17}\b/g,
    validate: (_value, context, index, languages) =>
      labelledBy("account", context, index, languages),
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
    // 04/12/1979, 14.02.1978, 1979-12-04, June 14, 1987, and the day first
    // with the month written out in any of the languages: 19 February 1987,
    // 14. Februar 1978, 14 septembre 1987, 14 de febrero de 1987.
    pattern: new RegExp(
      String.raw`\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}|\d{1,2}\.?\s+(?:de\s+)?(?:${MONTH_NAMES})\s+(?:de\s+)?\d{4})\b`,
      "g"
    ),
    validate: (_value, context, index, languages) =>
      labelledBy("birthDate", context, index, languages),
    reason: "A date labelled as a date of birth",
  },
  {
    id: "labelled-reference",
    category: "customer-id",
    confidence: 0.68,
    // ACME-88231, and the longer shapes references take: KD-4817-29,
    // CL-ES-740019, K-481-773-09, CL-804291-B.
    pattern: /\b[A-Z]{1,5}(?:-[A-Z]{1,3})?-?\d{3,10}(?:-[0-9A-Z]{1,6})*\b/g,
    validate: (_value, context, index, languages) =>
      labelledBy("reference", context, index, languages),
    reason: "An identifier labelled as a customer or case reference",
  },
  {
    id: "labelled-national-id",
    category: "government-id",
    // Above a phone number's confidence, because a labelled Steuer-ID written
    // in groups (49 782 584 941) is also a phone number's shape, and the label
    // is the better evidence of the two.
    confidence: 0.9,
    global: true,
    // A document number with at least one digit (CNKF48897, Z3184554W), or a
    // number in groups (49 782 584 941, 1 85 05 78 006 084 36).
    pattern: /\b(?=[A-Z]*\d)[A-Z0-9]{6,12}\b|\b\d{1,3}(?: \d{2,8}){2,6}\b/g,
    validate: (_value, context, index, languages) =>
      labelledBy("identity", context, index, languages),
    reason: "A number labelled as an identity document or tax number",
  },
  {
    id: "es-national-id",
    category: "government-id",
    confidence: 0.92,
    global: true,
    languages: ["es"],
    pattern: /\b(?:\d{8}|[XYZ]\d{7})-?[A-Z]\b/g,
    validate: (value) => passesDniCheck(value),
    reason: "A Spanish DNI or NIE with a valid check letter",
  },
  {
    id: "fr-social-security",
    category: "government-id",
    confidence: 0.92,
    global: true,
    languages: ["fr"],
    pattern: /\b[12] ?\d{2} ?\d{2} ?(?:\d{2}|2[AB]) ?\d{3} ?\d{3} ?\d{2}\b/g,
    validate: (value) => passesNirCheck(value),
    reason: "A French social security number (NIR) with a valid key",
  },
  {
    id: "de-tax-id",
    category: "government-id",
    confidence: 0.9,
    global: true,
    languages: ["de"],
    // Only as it is printed, in groups: one check digit in ten passes by
    // chance, which is too often for any eleven-digit number. Unspaced, it is
    // found when it is labelled (labelled-national-id).
    pattern: /\b[1-9]\d \d{3} \d{3} \d{3}\b/g,
    validate: (value) => passesSteuerIdCheck(value),
    reason: "A German tax identification number with a valid check digit",
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
    patterns: STREETS,
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
  /**
   * The languages the document may be in, from `detectorLanguages`: the one
   * it was detected to be in, or every one when that could not be told.
   * English runs whatever this says. Absent is English alone, which is what
   * every caller got before there was a choice.
   */
  languages?: readonly Language[]
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
  const languages = options.languages ?? ["en"]
  const found: Detection[] = []
  const enabled = options.detectors ? new Set(options.detectors) : null

  for (const detector of DETECTORS) {
    if (enabled && !enabled.has(detector.id)) continue
    if (
      detector.languages &&
      !detector.languages.some((language) => languages.includes(language))
    ) {
      continue
    }

    const patterns = [
      detector.pattern,
      ...languages.flatMap((language) => detector.patterns?.[language] ?? []),
    ]
    for (const pattern of patterns) {
      // The detectors are module-level and carry the `g` flag; resetting keeps
      // repeated calls independent.
      pattern.lastIndex = 0

      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const value = match[0]
        if (value.trim().length === 0) continue
        if (
          detector.validate &&
          !detector.validate(value, text, match.index, languages)
        ) {
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
