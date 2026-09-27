import type { Rng } from "./random"
import { RESERVED_PHONE_BLOCKS, TEST_CARD_NUMBERS } from "./reserved"
import type { Category, Locale } from "./types"

/**
 * The placeholder filler.
 *
 * The model never invents a value that has a checkable format. It writes
 * `{{PHONE}}` and this file supplies a number from a range reserved for
 * fiction; it writes `{{EMAIL:p1}}` and this file writes an address at an
 * RFC 2606 domain that matches cast member p1's name. That is what keeps real
 * data out, and it is also what makes every such value format-valid, so a
 * detector that misses one has genuinely missed it.
 *
 * Where no reserved range exists (most national IDs, IBANs, bank accounts),
 * values are random but checksum-valid. benchmarks/README.md lists which.
 */

export const PLACEHOLDER = /\{\{([A-Z_]+)(?::([A-Za-z0-9_-]+))?\}\}/g

export const PLACEHOLDER_CATEGORY: Record<string, Category> = {
  PHONE: "phone",
  EMAIL: "email",
  GOV_ID: "government-id",
  NATIONAL_ID: "government-id",
  TAX_ID: "government-id",
  PASSPORT: "government-id",
  DRIVING_LICENCE: "government-id",
  HEALTH_ID: "government-id",
  IBAN: "bank-account",
  ACCOUNT: "bank-account",
  SORT_CODE: "bank-account",
  ROUTING: "bank-account",
  CARD: "financial",
  SECRET: "api-key",
  URL: "url",
  IP: "other",
}

export type FillContext = {
  rng: Rng
  locale: Locale
  /** Cast member id → name, as the model wrote it. */
  cast: Map<string, string>
  /** Values already issued for a keyed placeholder, so `{{EMAIL:p1}}` repeats. */
  memo: Map<string, string>
}

export class PlaceholderError extends Error {}

/** The value for one placeholder. Keyed placeholders return the same value each time. */
export function fillPlaceholder(
  name: string,
  key: string | undefined,
  context: FillContext
): string {
  const generate = GENERATORS[name]
  if (!generate) throw new PlaceholderError(`unknown placeholder {{${name}}}`)
  if (key === undefined) return generate(context, undefined)
  const memoKey = `${name}:${key}`
  const existing = context.memo.get(memoKey)
  if (existing !== undefined) return existing
  const value = generate(context, key)
  context.memo.set(memoKey, value)
  return value
}

// --- names ------------------------------------------------------------------

const TITLES =
  /^(dr|mr|mrs|ms|mx|miss|prof|professor|sir|dame|herr|frau|mme|mlle|m|sr|sra|srta|don|doña|shri|smt|kumari)\.?$/i

/** "Dr. Priya Raman" → ["priya", "raman"], folded to ASCII. */
export function nameParts(name: string): string[] {
  return name
    .split(/\s+/)
    .filter((part) => part && !TITLES.test(part))
    .map(asciiFold)
    .filter(Boolean)
}

export function asciiFold(value: string): string {
  return value
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/ø/gi, "o")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
}

const FALLBACK_NAMES: Record<Locale, [string[], string[]]> = {
  "en-US": [
    ["alex", "jordan", "maria", "david", "keisha", "tom"],
    ["garcia", "nguyen", "miller", "okafor", "reyes", "kowalski"],
  ],
  "en-GB": [
    ["olivia", "rhys", "amira", "callum", "sophie", "tariq"],
    ["hughes", "patel", "fraser", "osei", "whitlock", "moran"],
  ],
  "de-DE": [
    ["lena", "jonas", "fatma", "lukas", "anke", "milan"],
    ["schneider", "yilmaz", "vogt", "hartmann", "brandt", "krueger"],
  ],
  "fr-FR": [
    ["camille", "yanis", "chloe", "hugo", "ines", "mathis"],
    ["lefebvre", "benali", "moreau", "girard", "fontaine", "rousseau"],
  ],
  "es-ES": [
    ["lucia", "hugo", "marta", "pablo", "irene", "sergio"],
    ["garcia", "martinez", "romero", "navarro", "iglesias", "molina"],
  ],
  "en-IN": [
    ["aarav", "diya", "rohan", "ananya", "vikram", "meera"],
    ["sharma", "iyer", "reddy", "banerjee", "nair", "gupta"],
  ],
}

function personParts(context: FillContext, key: string | undefined): string[] {
  const name = key ? context.cast.get(key) : undefined
  const parts = name ? nameParts(name) : []
  if (parts.length > 0) return parts
  const [firsts, lasts] = FALLBACK_NAMES[context.locale]
  return [context.rng.pick(firsts), context.rng.pick(lasts)]
}

const ORGS = [
  "northwind",
  "harbourline",
  "bluefield",
  "meridian-care",
  "oakridge",
  "lumen",
  "castellan",
  "brightwater",
  "kestrel",
  "fernhill",
  "quayside",
  "tidewell",
]

function reservedDomain(rng: Rng): string {
  return rng.weighted<string>([
    ["example.com", 3],
    ["example.org", 2],
    ["example.net", 2],
    [`${rng.pick(ORGS)}.example.com`, 3],
    [`mail.example.org`, 1],
  ])
}

// --- digits and checksums ---------------------------------------------------

/** ISO 13616 check digits for an IBAN. */
export function ibanCheckDigits(country: string, bban: string): string {
  const rearranged = `${bban}${country}00`
  const numeric = rearranged.replace(/[A-Z]/g, (ch) =>
    String(ch.charCodeAt(0) - 55)
  )
  let remainder = 0
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97
  return String(98 - remainder).padStart(2, "0")
}

export function isValidIban(value: string): boolean {
  const compact = value.replace(/\s/g, "").toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return false
  return (
    ibanCheckDigits(compact.slice(0, 2), compact.slice(4)) ===
    compact.slice(2, 4)
  )
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]
const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]

export function verhoeffCheckDigit(payload: string): string {
  let c = 0
  const digits = payload.split("").reverse().map(Number)
  for (let i = 0; i < digits.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][digits[i]]]
  }
  return String(VERHOEFF_INV[c])
}

export function isValidVerhoeff(value: string): boolean {
  let c = 0
  const digits = value.split("").reverse().map(Number)
  for (let i = 0; i < digits.length; i++)
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digits[i]]]
  return c === 0
}

/** ISO 7064 MOD 11,10, as used by the German Steuer-ID. */
function mod1110CheckDigit(payload: string): string {
  let product = 10
  for (const digit of payload) {
    let sum = (Number(digit) + product) % 10
    if (sum === 0) sum = 10
    product = (sum * 2) % 11
  }
  const check = 11 - product
  return String(check === 10 ? 0 : check)
}

/** NHS number check digit (modulus 11); null when the payload has none. */
function nhsCheckDigit(payload: string): string | null {
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(payload[i]) * (10 - i)
  const check = 11 - (sum % 11)
  if (check === 10) return null
  return String(check === 11 ? 0 : check)
}

function abaCheckDigit(payload: string): string {
  const d = payload.split("").map(Number)
  const sum =
    3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5])
  return String((10 - (sum % 10)) % 10)
}

function group(value: string, sizes: number[], separator: string): string {
  const out: string[] = []
  let at = 0
  for (const size of sizes) {
    if (at >= value.length) break
    out.push(value.slice(at, at + size))
    at += size
  }
  if (at < value.length) out.push(value.slice(at))
  return out.join(separator)
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// --- generators -------------------------------------------------------------

type Generator = (context: FillContext, key: string | undefined) => string

function reservedBlockDigits(rng: Rng, locale: Locale): string {
  const { blocks } = RESERVED_PHONE_BLOCKS[locale]
  const block = rng.pick(blocks)
  return block.prefix + rng.digits(block.free)
}

const US_AREA_CODES = [
  "212",
  "312",
  "415",
  "617",
  "206",
  "303",
  "512",
  "404",
  "702",
  "919",
  "503",
  "614",
  "215",
  "713",
]

function phone({ rng, locale }: FillContext): string {
  switch (locale) {
    case "en-US": {
      const area = rng.pick(US_AREA_CODES)
      const line = `01${rng.digits(2)}`
      return rng.pick([
        `(${area}) 555-${line}`,
        `${area}-555-${line}`,
        `+1 ${area} 555 ${line}`,
        `${area}.555.${line}`,
        `+1 (${area}) 555-${line}`,
      ])
    }
    case "en-GB": {
      const digits = reservedBlockDigits(rng, locale)
      const national =
        digits.startsWith("07") || digits.startsWith("01632")
          ? `${digits.slice(0, 5)} ${digits.slice(5)}`
          : digits.startsWith("020")
            ? `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`
            : `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`
      return rng.chance(0.3) ? `+44 ${national.slice(1)}` : national
    }
    case "de-DE": {
      const digits = reservedBlockDigits(rng, locale)
      const areaLength = digits.startsWith("0221") ? 4 : 3
      const area = digits.slice(0, areaLength)
      const rest = digits.slice(areaLength)
      return rng.pick([
        `${area} ${rest}`,
        `+49 ${area.slice(1)} ${rest}`,
        `(${area}) ${rest.slice(0, -3)}-${rest.slice(-3)}`,
        `${area}/${rest}`,
        `+49 (0)${area.slice(1)} ${rest.slice(0, -3)} ${rest.slice(-3)}`,
      ])
    }
    case "fr-FR": {
      const digits = reservedBlockDigits(rng, locale)
      const pairs = group(digits, [2, 2, 2, 2, 2], " ")
      return rng.pick([
        pairs,
        `+33 ${pairs.slice(1)}`,
        pairs.replace(/ /g, "."),
      ])
    }
    case "es-ES": {
      // No range is reserved for fiction in Spain; see UNRESERVED_PHONE_LOCALES.
      const mobile = `${rng.pick(["6", "7"])}${rng.digits(8)}`
      const landline = `9${rng.pick(["1", "3", "5", "6"])}${rng.digits(7)}`
      return rng.pick([
        group(mobile, [3, 3, 3], " "),
        `+34 ${group(mobile, [3, 3, 3], " ")}`,
        group(landline, [2, 3, 2, 2], " "),
      ])
    }
    case "en-IN": {
      // No range is reserved for fiction in India; see UNRESERVED_PHONE_LOCALES.
      const mobile = `${rng.pick(["7", "8", "9"])}${rng.digits(9)}`
      return rng.pick([
        `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}`,
        `+91-${mobile}`,
        `0${mobile.slice(0, 5)} ${mobile.slice(5)}`,
        `+91 22 ${rng.digits(4)} ${rng.digits(4)}`,
      ])
    }
  }
}

function email(context: FillContext, key: string | undefined): string {
  const { rng } = context
  const parts = personParts(context, key)
  const first = parts[0]
  const last = parts.length > 1 ? parts[parts.length - 1] : ""
  const local = last
    ? rng.pick([
        `${first}.${last}`,
        `${first[0]}.${last}`,
        `${first}${last}`,
        `${first}_${last}`,
        `${first}.${last}${rng.int(1, 99)}`,
        `${last}.${first}`,
        `${first[0]}${last}`,
      ])
    : `${first}${rng.int(1, 999)}`
  return `${local}@${reservedDomain(rng)}`
}

type IdKind =
  "NATIONAL_ID" | "TAX_ID" | "PASSPORT" | "DRIVING_LICENCE" | "HEALTH_ID"

/** US Social Security number from the block SSA reserves for advertising. */
function reservedSsn(rng: Rng): string {
  const last = rng.int(0, 9)
  return rng.pick([`987-65-432${last}`, `987 65 432${last}`, `98765432${last}`])
}

/** UK National Insurance number with the QQ prefix, which is never issued. */
function reservedNiNumber(rng: Rng): string {
  const body = `${rng.digits(2)} ${rng.digits(2)} ${rng.digits(2)}`
  const suffix = rng.pick(["A", "B", "C", "D"])
  return rng.chance(0.5)
    ? `QQ ${body} ${suffix}`
    : `QQ${body.replace(/ /g, "")}${suffix}`
}

/** NHS number from the 999 range reserved for testing, with a valid check digit. */
function reservedNhsNumber(rng: Rng): string {
  for (;;) {
    const payload = `999${rng.digits(6)}`
    const check = nhsCheckDigit(payload)
    if (check !== null) return group(payload + check, [3, 3, 4], " ")
  }
}

function steuerId(rng: Rng): string {
  const payload = `${rng.int(1, 9)}${rng.digits(9)}`
  return group(payload + mod1110CheckDigit(payload), [2, 3, 3, 3], " ")
}

function frenchNir(rng: Rng): string {
  const month = String(rng.int(1, 12)).padStart(2, "0")
  const department = String(rng.int(1, 95)).padStart(2, "0")
  const body = `${rng.pick(["1", "2"])}${rng.digits(2)}${month}${department}${rng.digits(3)}${rng.digits(3)}`
  const key = String(97 - Number(BigInt(body) % BigInt(97))).padStart(2, "0")
  return rng.chance(0.6)
    ? group(body + key, [1, 2, 2, 2, 3, 3, 2], " ")
    : body + key
}

function spanishDni(rng: Rng): string {
  const letters = "TRWAGMYFPDXBNJZSQVHLCKE"
  if (rng.chance(0.75)) {
    const number = rng.digits(8)
    return `${number}${letters[Number(number) % 23]}`
  }
  const prefix = rng.pick(["X", "Y", "Z"])
  const number = rng.digits(7)
  return `${prefix}${number}${letters[Number(`${"XYZ".indexOf(prefix)}${number}`) % 23]}`
}

function aadhaar(rng: Rng): string {
  const payload = `${rng.int(2, 9)}${rng.digits(10)}`
  return group(payload + verhoeffCheckDigit(payload), [4, 4, 4], " ")
}

/**
 * Identity numbers by locale and by what the document calls them, so a line
 * that says "SSN:" is followed by something shaped like one. Where a reserved
 * range exists it is used; everything else is random and checksum-valid.
 */
const GOVERNMENT_IDS: Record<Locale, Record<IdKind, (rng: Rng) => string>> = {
  "en-US": {
    NATIONAL_ID: reservedSsn,
    TAX_ID: reservedSsn,
    PASSPORT: (rng) => `${rng.int(5, 9)}${rng.digits(8)}`,
    DRIVING_LICENCE: (rng) => `${rng.chars(UPPER, 1)}${rng.digits(7)}`,
    // Medicare Beneficiary Identifier: 1EG4-TE5-MK73.
    HEALTH_ID: (rng) => {
      const letter = "ACDEFGHJKMNPQRTUVWXY"
      const both = letter + "0123456789"
      return `${rng.int(1, 9)}${rng.chars(letter, 1)}${rng.chars(both, 1)}${rng.digits(1)}-${rng.chars(letter, 1)}${rng.chars(both, 1)}${rng.digits(1)}-${rng.chars(letter, 2)}${rng.digits(2)}`
    },
  },
  "en-GB": {
    NATIONAL_ID: reservedNiNumber,
    TAX_ID: (rng) =>
      rng.chance(0.5)
        ? reservedNiNumber(rng)
        : `${rng.digits(5)} ${rng.digits(5)}`,
    PASSPORT: (rng) => rng.digits(9),
    DRIVING_LICENCE: (rng) =>
      `${rng.chars(UPPER, 5)}${rng.digits(6)}${rng.chars(UPPER, 2)}${rng.digits(1)}${rng.chars(UPPER, 2)}`,
    HEALTH_ID: reservedNhsNumber,
  },
  "de-DE": {
    NATIONAL_ID: (rng) =>
      `${rng.chars("CFGHJKLMNPRTVWXYZ", 1)}${rng.chars("CFGHJKLMNPRTVWXYZ0123456789", 8)}`,
    TAX_ID: steuerId,
    PASSPORT: (rng) => `C${rng.chars("CFGHJKLMNPRTVWXYZ0123456789", 8)}`,
    DRIVING_LICENCE: (rng) =>
      `${rng.chars(UPPER, 1)}${rng.digits(3)}${rng.chars(UPPER + "0123456789", 7)}`,
    HEALTH_ID: (rng) => `${rng.chars(UPPER, 1)}${rng.digits(9)}`,
  },
  "fr-FR": {
    NATIONAL_ID: (rng) => rng.chars("ABCDEFGHJKLMNPRSTUVWXYZ0123456789", 9),
    TAX_ID: (rng) => `${rng.int(0, 3)}${rng.digits(12)}`,
    PASSPORT: (rng) => `${rng.digits(2)}${rng.chars(UPPER, 2)}${rng.digits(5)}`,
    DRIVING_LICENCE: (rng) => rng.digits(12),
    HEALTH_ID: frenchNir,
  },
  "es-ES": {
    NATIONAL_ID: spanishDni,
    TAX_ID: spanishDni,
    PASSPORT: (rng) => `${rng.chars(UPPER, 3)}${rng.digits(6)}`,
    DRIVING_LICENCE: spanishDni,
    HEALTH_ID: (rng) => `${rng.digits(2)} ${rng.digits(8)} ${rng.digits(2)}`,
  },
  "en-IN": {
    NATIONAL_ID: aadhaar,
    TAX_ID: (rng) =>
      `${rng.chars(UPPER, 3)}P${rng.chars(UPPER, 1)}${rng.digits(4)}${rng.chars(UPPER, 1)}`,
    PASSPORT: (rng) => `${rng.chars(UPPER, 1)}${rng.digits(7)}`,
    DRIVING_LICENCE: (rng) =>
      `${rng.pick(["MH", "KA", "DL", "TN", "WB"])}${rng.digits(2)} ${rng.int(1995, 2024)}${rng.digits(7)}`,
    HEALTH_ID: (rng) =>
      `${rng.digits(2)}-${rng.digits(4)}-${rng.digits(4)}-${rng.digits(4)}`,
  },
}

function governmentId(kind: IdKind | null): Generator {
  return ({ rng, locale }) => {
    const chosen: IdKind =
      kind ??
      rng.weighted<IdKind>([
        ["NATIONAL_ID", 5],
        ["TAX_ID", 2],
        ["PASSPORT", 2],
        ["DRIVING_LICENCE", 2],
        ["HEALTH_ID", 1],
      ])
    return GOVERNMENT_IDS[locale][chosen](rng)
  }
}

function iban({ rng, locale }: FillContext): string {
  const country =
    locale === "de-DE"
      ? "DE"
      : locale === "fr-FR"
        ? "FR"
        : locale === "es-ES"
          ? "ES"
          : locale === "en-GB"
            ? "GB"
            : rng.pick(["GB", "DE"])
  const bban =
    country === "GB"
      ? `${rng.pick(["NWBK", "BARC", "LOYD", "HBUK", "MIDL"])}${rng.digits(6)}${rng.digits(8)}`
      : country === "DE"
        ? rng.digits(18)
        : country === "FR"
          ? rng.digits(23)
          : rng.digits(20)
  const compact = `${country}${ibanCheckDigits(country, bban)}${bban}`
  return rng.chance(0.75)
    ? group(compact, [4, 4, 4, 4, 4, 4, 4, 4], " ")
    : compact
}

function account({ rng, locale }: FillContext): string {
  const length = {
    "en-US": rng.int(10, 12),
    "en-GB": 8,
    "de-DE": 10,
    "fr-FR": 11,
    "es-ES": 10,
    "en-IN": rng.int(11, 14),
  }[locale]
  return `${rng.int(1, 9)}${rng.digits(length - 1)}`
}

function sortCode({ rng }: FillContext): string {
  return `${rng.digits(2)}-${rng.digits(2)}-${rng.digits(2)}`
}

function routing({ rng, locale }: FillContext): string {
  if (locale === "en-IN")
    return `${rng.chars(UPPER, 4)}0${rng.chars("ABCDEFGHJKLMNPQRSTUVWXYZ0123456789", 6)}` // IFSC
  if (locale === "en-US") {
    const payload = `${String(rng.pick([rng.int(1, 12), rng.int(21, 32)])).padStart(2, "0")}${rng.digits(6)}`
    return payload + abaCheckDigit(payload)
  }
  return `${rng.chars(UPPER, 4)}${locale.slice(3)}${rng.chars(UPPER + "0123456789", 2)}${rng.chance(0.5) ? "XXX" : ""}` // BIC
}

function card({ rng }: FillContext): string {
  const number = rng.pick(TEST_CARD_NUMBERS)
  const sizes =
    number.length === 15
      ? [4, 6, 5]
      : number.length === 14
        ? [4, 6, 4]
        : [4, 4, 4, 4]
  return rng.weighted<string>([
    [group(number, sizes, " "), 5],
    [group(number, sizes, "-"), 2],
    [number, 3],
  ])
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url")
}

function secret(context: FillContext): string {
  const { rng } = context
  return rng.weighted<() => string>([
    [() => `sk_test_${rng.chars(ALNUM, 24)}`, 3],
    [() => `pk_test_${rng.chars(ALNUM, 24)}`, 1],
    [() => rng.chars("0123456789abcdef", rng.pick([32, 40, 64])), 2],
    [
      () => {
        const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
        const payload = base64url(
          JSON.stringify({
            sub: rng.digits(8),
            iat: 1_700_000_000 + rng.int(0, 60_000_000),
          })
        )
        return `${header}.${payload}.${rng.chars(ALNUM + "-_", 43)}`
      },
      2,
    ],
    [
      () =>
        `${rng.pick(["Summer", "Harbour", "Blue", "Tiger", "Winter", "Maple"])}${rng.pick(["!", "#", "$", "@"])}${rng.digits(4)}${rng.chars(UPPER, 1)}`,
      2,
    ], // password
    [() => `anf_${rng.pick(["live", "test"])}_${rng.chars(ALNUM, 32)}`, 1],
  ])()
}

function url(context: FillContext, key: string | undefined): string {
  const { rng } = context
  const parts = personParts(context, key)
  const slug = parts.join("-")
  const domain = reservedDomain(rng)
  return rng.weighted<string>([
    [`https://www.${domain}/in/${slug}-${rng.digits(4)}`, 3],
    [
      `https://${parts.join("")}.${rng.pick(["example.com", "example.net", "example.org"])}`,
      2,
    ],
    [
      `https://files.${domain}/share/${rng.chars(ALNUM, 16)}?sig=${rng.chars(ALNUM, 24)}`,
      2,
    ],
    [`https://portal.${domain}/account/reset?token=${rng.chars(ALNUM, 20)}`, 1],
    [`https://${domain}/u/${parts[0]}${rng.int(1, 999)}`, 2],
  ])
}

function ip({ rng }: FillContext): string {
  return rng.weighted<string>([
    [`192.0.2.${rng.int(1, 254)}`, 3],
    [`198.51.100.${rng.int(1, 254)}`, 3],
    [`203.0.113.${rng.int(1, 254)}`, 3],
    [
      `2001:db8:${rng.int(0, 0xffff).toString(16)}::${rng.int(1, 0xffff).toString(16)}`,
      1,
    ],
  ])
}

const GENERATORS: Record<string, Generator> = {
  PHONE: phone,
  EMAIL: email,
  GOV_ID: governmentId(null),
  NATIONAL_ID: governmentId("NATIONAL_ID"),
  TAX_ID: governmentId("TAX_ID"),
  PASSPORT: governmentId("PASSPORT"),
  DRIVING_LICENCE: governmentId("DRIVING_LICENCE"),
  HEALTH_ID: governmentId("HEALTH_ID"),
  IBAN: iban,
  ACCOUNT: account,
  SORT_CODE: sortCode,
  ROUTING: routing,
  CARD: card,
  SECRET: secret,
  URL: url,
  IP: ip,
}
