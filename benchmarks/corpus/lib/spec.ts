import { createRng, quota, type Rng } from "./random"
import {
  CATEGORIES,
  type CastSpec,
  type Category,
  type Density,
  type DocumentSpec,
  type LengthBucket,
  type Locale,
  type RenderFormat,
  type Split,
} from "./types"

/**
 * The spec sampler.
 *
 * Each document's spec — type, locale, length, density, cast, required
 * categories and hard negatives — is decided here, before any model is called,
 * so that the corpus as a whole hits the distributions in issue #57. Where a
 * distribution is given as a percentage it is hit exactly, by dealing out a
 * shuffled deck of values, not approximately by rolling for each document.
 */

export const CORPUS_SIZE = 600
export const DEV_SHARE = 0.25

export const LENGTH_WEIGHTS: [LengthBucket, number][] = [
  ["short", 50],
  ["medium", 35],
  ["long", 15],
]

export const DENSITY_WEIGHTS: [Density, number][] = [
  ["none", 10],
  ["low", 30],
  ["medium", 40],
  ["high", 20],
]

export const LOCALE_WEIGHTS: [Locale, number][] = [
  ["en-US", 45],
  ["en-GB", 25],
  ["de-DE", 7.5],
  ["fr-FR", 7.5],
  ["es-ES", 7.5],
  ["en-IN", 7.5],
]

/** Words per bucket. A page is taken as ~500 words. */
export const LENGTH_WORDS: Record<LengthBucket, [number, number]> = {
  short: [150, 450],
  medium: [1000, 2500],
  long: [5000, 15000],
}

type DocType = {
  name: string
  /** Variants the prompt uses; `{n}` is replaced with a count. */
  details: string[]
  roles: string[]
  render: RenderFormat[]
  /** Categories this type carries naturally, weighted up when sampling. */
  likely: Category[]
  negatives: string[]
}

export const DOC_TYPES: DocType[] = [
  {
    name: "email thread",
    details: [
      "support email thread, {n} messages",
      "internal email thread between colleagues, {n} messages",
      "sales enquiry email thread, {n} messages",
      "email thread with a solicitor, {n} messages",
    ],
    roles: ["customer", "agent", "manager", "colleague", "solicitor", "client"],
    render: ["eml", "pdf", "txt"],
    likely: ["email", "phone", "customer-id", "address", "url"],
    negatives: [
      "a ticket number that is not tied to a person",
      "a quoted public company press line",
      "a generic role mailbox name written without an address, like 'the support team'",
    ],
  },
  {
    name: "invoice",
    details: [
      "invoice with line items",
      "invoice with a payment reminder",
      "credit note",
    ],
    roles: ["customer", "billing contact", "account manager"],
    render: ["pdf", "docx", "txt"],
    likely: ["address", "bank-account", "financial", "customer-id", "email"],
    negatives: [
      "an invoice number that looks like an account number",
      "product SKUs",
      "a VAT or company registration number of the supplier company",
    ],
  },
  {
    name: "bank statement",
    details: [
      "monthly bank statement",
      "credit card statement",
      "savings account statement",
    ],
    roles: ["account holder", "joint account holder", "payee"],
    render: ["pdf", "xlsx", "txt"],
    likely: ["bank-account", "financial", "address", "customer-id"],
    negatives: [
      "merchant names of public companies",
      "a transaction reference that looks like an account number",
      "a bank's public customer service line described without a number",
    ],
  },
  {
    name: "medical referral",
    details: [
      "GP referral letter",
      "specialist discharge summary",
      "clinic referral form",
    ],
    roles: ["patient", "referring doctor", "consultant", "next of kin"],
    render: ["pdf", "docx", "txt"],
    likely: [
      "date-of-birth",
      "customer-id",
      "address",
      "government-id",
      "phone",
    ],
    negatives: [
      "a public hospital name",
      "a drug name and dosage",
      "a clinical guideline reference number",
    ],
  },
  {
    name: "HR note",
    details: [
      "HR case note",
      "disciplinary meeting record",
      "salary review memo",
    ],
    roles: ["employee", "line manager", "HR partner", "witness"],
    render: ["docx", "pdf", "txt"],
    likely: [
      "customer-id",
      "financial",
      "date-of-birth",
      "confidential",
      "government-id",
    ],
    negatives: [
      "a job title on its own",
      "a policy document number",
      "a department name",
    ],
  },
  {
    name: "CV",
    details: ["CV / résumé", "CV with a cover letter"],
    roles: ["candidate", "referee"],
    render: ["docx", "pdf", "txt"],
    likely: ["email", "phone", "address", "url", "date-of-birth"],
    negatives: [
      "names of public universities and employers",
      "a professional certification ID that is not tied to a person",
      "historical figures mentioned in an interests section",
    ],
  },
  {
    name: "support chat",
    details: [
      "customer support chat transcript",
      "live chat log with a bot handover",
    ],
    roles: ["customer", "agent", "supervisor"],
    render: ["txt", "pdf"],
    likely: ["customer-id", "email", "phone", "financial", "api-key", "other"],
    negatives: ["an order number", "a product model number", "a bot's name"],
  },
  {
    name: "contract",
    details: [
      "employment contract",
      "tenancy agreement",
      "consulting agreement",
      "NDA",
    ],
    roles: ["party", "counterparty", "witness", "signatory"],
    render: ["docx", "pdf", "txt"],
    likely: [
      "address",
      "financial",
      "confidential",
      "government-id",
      "bank-account",
    ],
    negatives: [
      '"John Doe" in a blank signature template',
      "a statute or clause reference",
      "a public company acting as a company",
    ],
  },
  {
    name: "meeting minutes",
    details: [
      "board meeting minutes",
      "project steering group minutes",
      "residents' association minutes",
    ],
    roles: ["chair", "attendee", "minute-taker", "guest"],
    render: ["docx", "pdf", "txt"],
    likely: ["confidential", "person", "email", "financial"],
    negatives: [
      "a public figure mentioned as a public figure",
      "a project ticket number",
      "dates of meetings that are not birthdays",
    ],
  },
  {
    name: "tabular export",
    details: [
      "CSV export from a CRM",
      "spreadsheet export of a membership list",
      "CSV export of support tickets",
    ],
    roles: ["customer", "member", "account owner"],
    render: ["csv", "xlsx"],
    likely: ["email", "phone", "customer-id", "address", "date-of-birth"],
    negatives: [
      "SKUs or plan codes in a column",
      "row IDs that look like customer numbers but are not tied to a person",
      "column headers that name a category, like 'Email'",
    ],
  },
  {
    name: "incident report",
    details: [
      "police incident report",
      "workplace incident report",
      "security incident report",
    ],
    roles: ["reporting officer", "witness", "subject", "victim"],
    render: ["pdf", "docx", "txt"],
    likely: ["address", "date-of-birth", "other", "government-id", "phone"],
    negatives: [
      "a public building or landmark",
      "a case reference that belongs to the organisation, not a person",
      "a vehicle make and model without a plate",
    ],
  },
  {
    name: "API/config dump",
    details: [
      "application config file with comments",
      "API request/response log",
      ".env file and deployment notes",
    ],
    roles: ["developer", "on-call engineer", "customer"],
    render: ["txt"],
    likely: ["api-key", "email", "url", "other", "confidential"],
    negatives: [
      "a version string or git commit hash",
      "a public package name",
      "a UUID that is a request ID, not tied to a person",
    ],
  },
]

const GENERAL_NEGATIVES = [
  "an invoice or order number",
  "a public company name",
  "a historical figure",
  '"John Doe" in a blank template',
  "a SKU or product code",
  "a date that is not a date of birth",
  "a public building",
]

/** Categories other than `person`, which the cast already guarantees. */
const INCLUDABLE: Category[] = CATEGORIES.filter((c) => c !== "person")

/**
 * Categories the corpus has to carry at least 250 of in the test split rather
 * than 400. They are weighted up so they get there.
 */
export const RARE_CATEGORIES: Category[] = ["api-key", "date-of-birth"]

const MUST_INCLUDE_COUNT: Record<Density, [number, number]> = {
  none: [0, 0],
  low: [3, 4],
  medium: [5, 7],
  high: [8, 11],
}

const CAST_SIZE: Record<Density, [number, number]> = {
  none: [0, 0],
  low: [1, 2],
  medium: [2, 4],
  high: [3, 6],
}

const MENTION_CAP: Record<LengthBucket, number> = {
  short: 6,
  medium: 12,
  long: 20,
}

export function documentId(index: number): string {
  return `syn-v1-${String(index + 1).padStart(4, "0")}`
}

function sampleCast(
  rng: Rng,
  type: DocType,
  density: Density,
  length: LengthBucket
): CastSpec[] {
  const [min, max] = CAST_SIZE[density]
  const size =
    rng.int(min, max) + (length === "long" && density !== "none" ? 1 : 0)
  const cap = MENTION_CAP[length]
  const cast: CastSpec[] = []
  for (let i = 0; i < size; i++) {
    // The first cast member is the document's main entity and repeats most:
    // that is where #55 measures what expanding a value to its repeats saves.
    const mentions =
      i === 0
        ? rng.int(Math.ceil(cap / 2), cap)
        : rng.int(1, Math.ceil(cap / 2))
    cast.push({
      id: `p${i + 1}`,
      role: type.roles[i % type.roles.length],
      mentions,
    })
  }
  return cast
}

function sampleMustInclude(
  rng: Rng,
  type: DocType,
  density: Density
): Category[] {
  const [min, max] = MUST_INCLUDE_COUNT[density]
  const count = Math.min(rng.int(min, max), INCLUDABLE.length)
  const pool = INCLUDABLE.map((category) => {
    let weight = 1
    if (type.likely.includes(category)) weight *= 3
    if (RARE_CATEGORIES.includes(category)) weight *= 1.5
    return [category, weight] as [Category, number]
  })
  const chosen: Category[] = []
  while (chosen.length < count) {
    const next = rng.weighted(
      pool.filter(([category]) => !chosen.includes(category))
    )
    chosen.push(next)
  }
  // Keep the order stable so the prompt for a spec never depends on draw order.
  return INCLUDABLE.filter((category) => chosen.includes(category))
}

function sampleNegatives(rng: Rng, type: DocType, density: Density): string[] {
  const count = density === "none" ? rng.int(3, 4) : rng.int(1, 3)
  const pool = [...new Set([...type.negatives, ...GENERAL_NEGATIVES])]
  const typed = rng.sample(
    type.negatives,
    Math.min(count, type.negatives.length, 2)
  )
  const rest = rng.sample(
    pool.filter((negative) => !typed.includes(negative)),
    count - typed.length
  )
  return [...typed, ...rest]
}

/**
 * The spec for every document in a corpus of `size`. Stable for a given seed
 * and size: document 42's spec does not change when document 43 is rejected.
 */
export function sampleSpecs(seed: number, size = CORPUS_SIZE): DocumentSpec[] {
  const deck = createRng(seed, "deck", size)
  const devCount = Math.round(size * DEV_SHARE)
  const splits = deck.shuffle<Split>([
    ...Array<Split>(devCount).fill("dev"),
    ...Array<Split>(size - devCount).fill("test"),
  ])
  const lengths = quota(deck, size, LENGTH_WEIGHTS)
  const densities = quota(deck, size, DENSITY_WEIGHTS)
  const locales = quota(deck, size, LOCALE_WEIGHTS)
  const types = quota(
    deck,
    size,
    DOC_TYPES.map((type) => [type.name, 1] as [string, number])
  )

  return Array.from({ length: size }, (_, index) => {
    const rng = createRng(seed, "spec", index)
    const type = DOC_TYPES.find((candidate) => candidate.name === types[index])!
    const length = lengths[index]
    const density = densities[index]
    const [minWords, maxWords] = LENGTH_WORDS[length]
    // Round to something a person would write in a brief.
    const targetWords = Math.round(rng.int(minWords, maxWords) / 50) * 50

    return {
      id: documentId(index),
      index,
      split: splits[index],
      docType: type.name,
      docTypeDetail: rng
        .pick(type.details)
        .replace("{n}", String(rng.int(2, length === "short" ? 4 : 9))),
      locale: locales[index],
      length,
      targetWords,
      density,
      cast: sampleCast(rng, type, density, length),
      mustInclude: sampleMustInclude(rng, type, density),
      negatives: sampleNegatives(rng, type, density),
      render: type.render,
    }
  })
}

export function describeLength(spec: DocumentSpec): string {
  const pages = spec.targetWords / 500
  const words = spec.targetWords.toLocaleString("en-US")
  if (pages < 1) return `under one page (~${words} words)`
  return `about ${Math.round(pages)} page${Math.round(pages) === 1 ? "" : "s"} (~${words} words)`
}
