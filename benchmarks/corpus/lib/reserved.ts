import type { Locale } from "./types"

/**
 * Reserved ranges: values that are guaranteed not to belong to anybody.
 *
 * This file is the single answer to "may this value appear in the corpus?".
 * The generator draws its values from here, rejects a document that contains
 * anything outside it, and the CI check (`pnpm corpus:check`) holds every
 * committed file to it. If you add a range, cite where it is reserved.
 */

// --- email and web ----------------------------------------------------------

/**
 * RFC 2606 / RFC 6761: example.com, example.net and example.org and anything
 * under them, and the `.example`, `.test`, `.invalid` and `.localhost` TLDs.
 */
export function isReservedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "")
  if (/(^|\.)example\.(com|net|org)$/.test(name)) return true
  if (/\.(example|test|invalid|localhost)$/.test(name)) return true
  return name === "localhost"
}

export function isReservedEmail(value: string): boolean {
  const at = value.lastIndexOf("@")
  return at > 0 && isReservedHost(value.slice(at + 1))
}

export function isReservedUrl(value: string): boolean {
  const host = urlHost(value)
  return host !== null && (isReservedHost(host) || isReservedIp(host))
}

function urlHost(value: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`
  try {
    return new URL(withScheme).hostname.replace(/^\[|\]$/g, "")
  } catch {
    return null
  }
}

// --- IP addresses -----------------------------------------------------------

/**
 * RFC 5737 documentation blocks (192.0.2.0/24, 198.51.100.0/24,
 * 203.0.113.0/24), RFC 3849's 2001:db8::/32, and private or loopback space,
 * which identifies nobody outside the network it is on.
 */
export function isReservedIp(value: string): boolean {
  if (value.includes(":"))
    return /^2001:0?db8(:|$)/i.test(value) || value === "::1"
  const parts = value.split(".").map(Number)
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return false
  }
  const [a, b, c] = parts
  return (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  )
}

// --- telephone numbers ------------------------------------------------------

/**
 * Number ranges a national regulator has set aside for fiction, written as the
 * national significant number with its trunk prefix. Each block is a prefix
 * followed by `free` digits.
 */
export const RESERVED_PHONE_BLOCKS: Record<
  string,
  { source: string; blocks: { prefix: string; free: number }[] }
> = {
  // NANPA: 555-0100 to 555-0199 in every area code.
  "en-US": {
    source: "NANPA, 555-01XX fictitious numbers",
    blocks: [{ prefix: "NXX55501", free: 2 }],
  },
  // Ofcom, "Telephone numbers for use in TV and radio drama programmes".
  "en-GB": {
    source: "Ofcom drama numbers",
    blocks: [
      { prefix: "07700900", free: 3 },
      { prefix: "02079460", free: 3 },
      { prefix: "01134960", free: 3 },
      { prefix: "01144960", free: 3 },
      { prefix: "01154960", free: 3 },
      { prefix: "01164960", free: 3 },
      { prefix: "01174960", free: 3 },
      { prefix: "01184960", free: 3 },
      { prefix: "01214960", free: 3 },
      { prefix: "01314960", free: 3 },
      { prefix: "01414960", free: 3 },
      { prefix: "01514960", free: 3 },
      { prefix: "01614960", free: 3 },
      { prefix: "01632960", free: 3 },
    ],
  },
  // Bundesnetzagentur Mitteilung 148/2021, "Rufnummern für Medienproduktionen".
  "de-DE": {
    source: "Bundesnetzagentur drama numbers (Mitteilung 148/2021)",
    blocks: [
      { prefix: "03023125", free: 3 },
      { prefix: "06990009", free: 3 },
      { prefix: "04066969", free: 3 },
      { prefix: "02214710", free: 3 },
      { prefix: "08999998", free: 3 },
    ],
  },
  // ARCEP: six blocks of 10,000 numbers for audiovisual works.
  "fr-FR": {
    source: "ARCEP numbers for audiovisual works",
    blocks: [
      { prefix: "019900", free: 4 },
      { prefix: "026191", free: 4 },
      { prefix: "035301", free: 4 },
      { prefix: "046571", free: 4 },
      { prefix: "053649", free: 4 },
      { prefix: "063998", free: 4 },
    ],
  },
}

/**
 * Country codes the corpus's locales dial, the trunk prefix a national number
 * is written with there, and the locale whose ranges apply. Spain and India
 * reserve no numbers for fiction; they are here so that a +34 or +91 number is
 * read as Spanish or Indian, and so not reserved.
 */
const COUNTRY_CODES: { code: string; trunk: string; locale: Locale }[] = [
  { code: "1", trunk: "", locale: "en-US" },
  { code: "44", trunk: "0", locale: "en-GB" },
  { code: "49", trunk: "0", locale: "de-DE" },
  { code: "33", trunk: "0", locale: "fr-FR" },
  { code: "34", trunk: "", locale: "es-ES" },
  { code: "91", trunk: "0", locale: "en-IN" },
]

/**
 * Whose number this is, and its national number with the trunk prefix, from
 * any common way of writing it: "+44 (0)20 7946 0123", "0044 20 7946 0123",
 * "(212) 555-0142". An international number belongs to the country its code
 * names, or to none the corpus knows; a national one to the document's
 * locale, since that is where a reader would dial it.
 */
function dialledNumber(
  value: string,
  locale: Locale | null
): { locale: Locale | null; digits: string } {
  let digits = value.replace(/\(0\)/g, "").replace(/\D/g, "")
  if (/^\s*(\+|00)/.test(value)) {
    if (digits.startsWith("00")) digits = digits.slice(2)
    const country = COUNTRY_CODES.find(({ code }) => digits.startsWith(code))
    if (!country) return { locale: null, digits }
    return {
      locale: country.locale,
      digits: country.trunk + digits.slice(country.code.length),
    }
  }
  // A NANP number with its long-distance 1: 1 212 555 0142.
  if (locale === "en-US" && digits.length === 11 && digits.startsWith("1"))
    digits = digits.slice(1)
  return { locale, digits }
}

function matchesBlock(digits: string, prefix: string, free: number): boolean {
  if (digits.length !== prefix.length + free) return false
  for (let i = 0; i < prefix.length; i++) {
    const want = prefix[i]
    const got = digits[i]
    if (
      want === "N"
        ? !/[2-9]/.test(got)
        : want === "X"
          ? !/\d/.test(got)
          : want !== got
    ) {
      return false
    }
  }
  return /^\d+$/.test(digits.slice(prefix.length))
}

/**
 * True when the number is in a range reserved for fiction in its own country:
 * the one its country code names, or `locale`, the document's, when it is
 * written nationally. In a British document 020 7946 0123 is an Ofcom drama
 * number; in an American one it is no British number at all, and the drama
 * number is written +44 20 7946 0123. With no locale, a national number is
 * reserved nowhere.
 */
export function isReservedPhone(value: string, locale: Locale | null): boolean {
  const number = dialledNumber(value, locale)
  if (!number.locale) return false
  const blocks = RESERVED_PHONE_BLOCKS[number.locale]?.blocks ?? []
  return blocks.some(({ prefix, free }) =>
    matchesBlock(number.digits, prefix, free)
  )
}

// --- payment cards ----------------------------------------------------------

/**
 * Card numbers the networks and processors publish for testing. They pass
 * Luhn, so a detector treats them as real cards, and none can be charged.
 */
export const TEST_CARD_NUMBERS = [
  "4111111111111111",
  "4242424242424242",
  "4012888888881881",
  "4000056655665556",
  "4000000000000002",
  "5555555555554444",
  "5105105105105100",
  "2223003122003222",
  "5200828282828210",
  "378282246310005",
  "371449635398431",
  "6011111111111117",
  "6011000990139424",
  "3056930009020004",
  "36227206271667",
  "3530111333300000",
  "3566002020360505",
  "6200000000000005",
]

export function isTestCard(value: string): boolean {
  return TEST_CARD_NUMBERS.includes(value.replace(/[\s-]/g, ""))
}

// --- scanning ---------------------------------------------------------------

export type Finding = {
  kind: "email" | "phone" | "url" | "ip"
  start: number
  end: number
  value: string
  reserved: boolean
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi
const URL_WITH_SCHEME = /\b(?:https?|ftp):\/\/[^\s<>"'`)\]}|,;]+/gi
const WWW = /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'`)\]}|,;]*)?/gi
/**
 * A bare domain with a common TLD: "acme.com", "shop.acme.co.uk". Not file
 * names — `.json`, `.ts`, `.md` are not in the list.
 */
const BARE_DOMAIN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|uk|de|fr|es|in|info|biz|eu|us|app|dev|ai|me)\b(?:\/[^\s<>"'`)\]}|,;]*)?/gi
/**
 * Anything that could be a telephone number: digit groups joined by single
 * spaces, dots, dashes or a slash, optionally with a country code or a
 * bracketed area code. Not part of a longer token, so "INV-2026-08543" and
 * "TXN-938472847" are not candidates. `looksLikePhone` then keeps the shapes
 * a real number takes.
 */
const PHONE =
  /(?<![\p{L}\p{N}_+./-])(?:(?:\+|00)\d{1,3}[ .-]?)?(?:\(0\)[ .-]?)?(?:\(\d{2,5}\)[ .-]?|\d{1,5}(?:[ .-]|\/)?)\d{2,4}(?:[ .-]?\d{2,4}){0,3}(?![\p{L}\p{N}_-])/gu

/**
 * The shapes a telephone number actually takes: international (+ or 00),
 * national with a trunk 0, NANP (NXX-NXX-XXXX), and the Spanish and Indian
 * forms that have no trunk prefix. A reference like "2026 08543" is none of
 * these, and a model that disguises a real number as one would have to
 * produce something no reader would dial.
 */
export function looksLikePhone(value: string): boolean {
  if (/^(\+|00)/.test(value)) return true
  if (/^\(?0/.test(value)) return true
  if (/^1?[ .-]?\(?[2-9]\d{2}\)?[ .-]?[2-9]\d{2}[ .-]?\d{4}$/.test(value))
    return true
  if (/^[6-9]\d{2}[ .-]?\d{3}[ .-]?\d{3}$/.test(value)) return true
  if (/^9\d[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}$/.test(value)) return true
  if (/^[6-9]\d{4}[ .-]?\d{5}$/.test(value)) return true
  return false
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
/**
 * An IPv6 address in full (eight groups) or compressed with "::", standing on
 * its own: not part of a longer run of groups, so a time such as 10:30:00 or a
 * six-group MAC address is not one, and neither is `std::vector`.
 */
const IPV6 =
  /(?<![\p{L}\p{N}_:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\p{L}\p{N}_:])/giu

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/, "")
}

/**
 * Every email, URL, phone number and IP address in `text`, each marked with
 * whether it is in a reserved range. Findings do not overlap: an email is not
 * also reported as a domain, and a URL's host is not reported separately.
 * `locale` is the document's, which a nationally written phone number is
 * judged by; see `isReservedPhone`.
 */
export function scanForIdentifiers(
  text: string,
  locale: Locale | null
): Finding[] {
  const findings: Finding[] = []
  const taken: [number, number][] = []
  const free = (start: number, end: number) =>
    !taken.some(([s, e]) => start < e && end > s)
  const add = (finding: Finding) => {
    if (!free(finding.start, finding.end)) return
    findings.push(finding)
    taken.push([finding.start, finding.end])
  }

  for (const match of text.matchAll(EMAIL)) {
    const value = match[0]
    add({
      kind: "email",
      start: match.index,
      end: match.index + value.length,
      value,
      reserved: isReservedEmail(value),
    })
  }
  for (const pattern of [URL_WITH_SCHEME, WWW, BARE_DOMAIN]) {
    for (const match of text.matchAll(pattern)) {
      const value = trimTrailingPunctuation(match[0])
      add({
        kind: "url",
        start: match.index,
        end: match.index + value.length,
        value,
        reserved: isReservedUrl(value),
      })
    }
  }
  for (const match of text.matchAll(PHONE)) {
    const raw = match[0]
    const leading = raw.length - raw.trimStart().length
    const value = raw.trim()
    // Counted without the 00 of an international prefix or a bracketed trunk
    // 0, so "0044 (0)20 7946 0123" is as much a candidate as "020 7946 0123".
    const digits = value
      .replace(/\(0\)/g, "")
      .replace(/\D/g, "")
      .replace(/^00/, "")
    if (digits.length < 9 || digits.length > 13 || !looksLikePhone(value))
      continue
    const start = match.index + leading
    add({
      kind: "phone",
      start,
      end: start + value.length,
      value,
      reserved: isReservedPhone(value, locale),
    })
  }

  for (const pattern of [IPV4, IPV6]) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0]
      if (
        pattern === IPV4 &&
        value.split(".").some((part) => Number(part) > 255 || /^0\d/.test(part))
      )
        continue
      // A bare "::" (a C++ or Ruby scope, "a :: b") is not an address.
      if (pattern === IPV6 && value === "::") continue
      add({
        kind: "ip",
        start: match.index,
        end: match.index + value.length,
        value,
        reserved: isReservedIp(value),
      })
    }
  }
  return findings.sort((a, b) => a.start - b.start)
}
