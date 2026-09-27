import { z } from "zod"

import { createRng } from "./random"
import {
  CATEGORIES,
  isCategory,
  type Category,
  type LabelledDocument,
} from "./types"

/**
 * The cross-family validator (issue #57, step 5).
 *
 * A second model, from a different family than the one that wrote the
 * document, reads it with its labels inline and names anything it thinks is
 * personal data but unlabelled, or labelled but not personal data. It decides
 * nothing: every disagreement goes to a person, who edits the labels.
 */

export const REVIEW_PROMPT_VERSION = "1"

export const REVIEW_SYSTEM_PROMPT = `You review labelled test documents for a PII redaction tool. The documents
are fictional. Personal data in them is marked up inline as [[category|value]].

Categories:
${CATEGORIES.join(", ")}

(person: a private individual's name in any form; address: a postal address or
a specific part of one; government-id: national ID, SSN, passport, licence, tax
ID; bank-account: account number, sort code, IBAN, routing number; financial:
card number, salary, a specific person's balance or debt; date-of-birth: a date
of birth or an identifying age; customer-id: a customer, patient, employee,
member or case number tied to a person; confidential: internal codenames,
unreleased figures, trade secrets; api-key: secrets, tokens, passwords; url: a
URL that identifies a person; other: anything else that identifies a person,
such as a licence plate or IP address.)

NOT personal data: company names acting as companies, product codes, invoice
and order numbers, public buildings, job titles alone, dates that are not
birthdays, public figures mentioned as public figures.

Report two kinds of error:
1. "missed": personal data in the text that is NOT inside [[...]] markup.
   Quote the value exactly as it appears in the text, without markup.
2. "wrong": a [[category|value]] whose value is not personal data, or whose
   category is wrong. Give the value, the category it was labelled with, and
   the correct category or "not-pii".

Report nothing you are unsure of. An empty list is a good answer. Output JSON
only, matching the schema.`

export function reviewUserPrompt(document: LabelledDocument): string {
  return `Document type: ${document.docTypeDetail}
Locale: ${document.locale}

---
${withMarkup(document)}
---`
}

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["missed", "wrong"],
  properties: {
    missed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value", "category", "reason"],
        properties: {
          value: { type: "string" },
          category: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    wrong: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value", "labelled", "correct", "reason"],
        properties: {
          value: { type: "string" },
          labelled: { type: "string" },
          correct: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const

const ReviewSchema = z.object({
  missed: z.array(
    z.object({ value: z.string(), category: z.string(), reason: z.string() })
  ),
  wrong: z.array(
    z.object({
      value: z.string(),
      labelled: z.string(),
      correct: z.string(),
      reason: z.string(),
    })
  ),
})

/** The document's text with its labels put back inline. */
export function withMarkup(document: LabelledDocument): string {
  let out = ""
  let at = 0
  for (const span of [...document.spans].sort((a, b) => a.start - b.start)) {
    out += document.text.slice(at, span.start)
    out += `[[${span.category}|${span.value}]]`
    at = span.end
  }
  return out + document.text.slice(at)
}

export type Disagreement =
  | {
      kind: "missed"
      value: string
      category: Category | "unknown"
      reason: string
      /** Every unlabelled occurrence, so the reviewer can label them all. */
      at: { start: number; end: number }[]
    }
  | {
      kind: "wrong"
      value: string
      labelled: Category
      correct: Category | "not-pii" | "unknown"
      reason: string
      at: { start: number; end: number }[]
    }

export type ReviewResult = {
  disagreements: Disagreement[]
  /** Reported values that could not be found, which say nothing about the labels. */
  unlocated: number
}

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number }
) {
  return a.start < b.end && a.end > b.start
}

/**
 * Parses a validator's response and ties each claim to positions in the text.
 * A "missed" value that does not appear unlabelled in the text, or a "wrong"
 * one that matches no label, is dropped: the validator is a second opinion,
 * and one about text that is not there is not an opinion about these labels.
 */
export function readReview(
  document: LabelledDocument,
  raw: string
): ReviewResult {
  let text = raw.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text)
  if (fenced) text = fenced[1]
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first === -1 || last < first)
    throw new Error("the response contains no JSON object")
  const review = ReviewSchema.parse(JSON.parse(text.slice(first, last + 1)))

  const disagreements: Disagreement[] = []
  let unlocated = 0

  for (const claim of review.missed) {
    const value = claim.value
      .replace(/^\[\[[a-z-]+\|/, "")
      .replace(/\]\]$/, "")
      .trim()
    const at: { start: number; end: number }[] = []
    if (value) {
      let from = 0
      for (;;) {
        const start = document.text.indexOf(value, from)
        if (start === -1) break
        const hit = { start, end: start + value.length }
        if (!document.spans.some((span) => overlaps(span, hit))) at.push(hit)
        from = start + 1
      }
    }
    if (at.length === 0) {
      unlocated++
      continue
    }
    disagreements.push({
      kind: "missed",
      value,
      category: isCategory(claim.category) ? claim.category : "unknown",
      reason: claim.reason,
      at,
    })
  }

  for (const claim of review.wrong) {
    const matching = document.spans.filter(
      (span) =>
        span.value === claim.value.trim() && span.category === claim.labelled
    )
    if (matching.length === 0) {
      unlocated++
      continue
    }
    disagreements.push({
      kind: "wrong",
      value: matching[0].value,
      labelled: matching[0].category,
      correct:
        claim.correct === "not-pii" || isCategory(claim.correct)
          ? claim.correct
          : "unknown",
      reason: claim.reason,
      at: matching.map(({ start, end }) => ({ start, end })),
    })
  }

  return { disagreements, unlocated }
}

// --- review files -----------------------------------------------------------

export type Validator = {
  backend: string
  model: string
  promptVersion: string
}

/** A later pass over a document that already has a review file. */
export type Revalidation = {
  documentSha256: string
  validator: Validator
  validatedAt: string
  /** Claims nothing earlier in the file made. These are what a person reads. */
  disagreements: Disagreement[]
  /** Claims earlier in the file that this pass made again. */
  repeated: { kind: Disagreement["kind"]; value: string }[]
  note?: string
}

/** `review/<id>.json`. */
export type ReviewFile = {
  id: string
  documentSha256: string
  validator: Validator
  /**
   * "open" until a person settles it, by setting anything else ("resolved").
   * "superseded" when the document changed and a later pass flagged nothing.
   */
  status: string
  /** A person's account of what they changed and which claims they rejected. */
  resolution: unknown
  disagreements: Disagreement[]
  revalidations?: Revalidation[]
}

export type ReviewPass = {
  id: string
  documentSha256: string
  validator: Validator
  validatedAt: string
  disagreements: Disagreement[]
}

export type ReviewOutcome = {
  /** The review file after this pass, or null if there is none. */
  review: ReviewFile | null
  /** Whether `review` differs from what is on disk. */
  write: boolean
  /** Claims this pass made that are not already in the review file. */
  added: Disagreement[]
  /** Claims this pass repeated from the review file. */
  repeated: number
  /** The document changed since an open review and nothing is flagged now. */
  superseded: boolean
  /** A settled review that this pass opened again. */
  reopened: boolean
}

/** Whether a person has settled the review. */
export function isSettled(review: ReviewFile): boolean {
  return review.status !== "open" && review.status !== "superseded"
}

function claimKey(claim: { kind: string; value: string }): string {
  return `${claim.kind}\u0000${claim.value}`
}

function sameValidator(a: Validator, b: Validator): boolean {
  return (
    a.backend === b.backend &&
    a.model === b.model &&
    a.promptVersion === b.promptVersion
  )
}

/**
 * What a validator pass does to a document's review file.
 *
 * A person's work in the file is never overwritten. A pass over a document
 * that already has a review appends to `revalidations`, listing only the
 * claims the file does not already hold, so a claim a person has rejected is
 * not raised again; a new claim reopens a settled review, with its resolution
 * kept. The file is replaced only while nobody has touched it and it describes
 * a version of the document that is gone. An open review whose document has
 * since changed, and now draws no claims, is marked superseded rather than
 * deleted.
 */
export function nextReview(
  existing: ReviewFile | null,
  pass: ReviewPass
): ReviewOutcome {
  const fresh = (): ReviewOutcome => ({
    review: {
      id: pass.id,
      documentSha256: pass.documentSha256,
      validator: pass.validator,
      status: "open",
      resolution: null,
      disagreements: pass.disagreements,
    },
    write: true,
    added: pass.disagreements,
    repeated: 0,
    superseded: false,
    reopened: false,
  })
  const unchanged: ReviewOutcome = {
    review: existing,
    write: false,
    added: [],
    repeated: 0,
    superseded: false,
    reopened: false,
  }
  const record = {
    documentSha256: pass.documentSha256,
    validator: pass.validator,
    validatedAt: pass.validatedAt,
  }

  if (!existing) return pass.disagreements.length > 0 ? fresh() : unchanged

  const history = existing.revalidations ?? []
  const last = history.at(-1) ?? existing
  const documentChanged = last.documentSha256 !== pass.documentSha256

  if (pass.disagreements.length === 0) {
    if (existing.status !== "open" || !documentChanged) return unchanged
    return {
      ...unchanged,
      review: {
        ...existing,
        status: "superseded",
        revalidations: [
          ...history,
          {
            ...record,
            disagreements: [],
            repeated: [],
            note: "The document changed and this pass flagged nothing.",
          },
        ],
      },
      write: true,
      superseded: true,
    }
  }

  if (documentChanged && !isSettled(existing) && existing.resolution == null)
    return fresh()

  const known = new Set(
    [existing, ...history].flatMap((entry) => entry.disagreements.map(claimKey))
  )
  const added = pass.disagreements.filter((d) => !known.has(claimKey(d)))
  const repeated = pass.disagreements
    .filter((d) => known.has(claimKey(d)))
    .map(({ kind, value }) => ({ kind, value }))
  const reopened = isSettled(existing) && added.length > 0
  const status = isSettled(existing) && !reopened ? existing.status : "open"

  // The same validator saying the same things about the same text again.
  if (
    added.length === 0 &&
    status === existing.status &&
    !documentChanged &&
    sameValidator(last.validator, pass.validator)
  ) {
    return { ...unchanged, repeated: repeated.length }
  }

  return {
    review: {
      ...existing,
      status,
      revalidations: [
        ...history,
        { ...record, disagreements: added, repeated },
      ],
    },
    write: true,
    added,
    repeated: repeated.length,
    superseded: false,
    reopened,
  }
}

// --- the human spot-check ---------------------------------------------------

/** `review/spot-check.json`. */
export type SpotCheck = {
  note: string
  /** The test-split size the sample is a tenth of. Absent in older files. */
  drawnFrom?: number
  ids: string[]
  log: { id: string; reviewer: string; date: string; changed: string }[]
}

/**
 * The tenth of the test split a person checks whether or not the validator
 * flagged anything. Documents once chosen stay chosen, with their log entries;
 * when the split has grown since the draw, as it does after a trial run, the
 * sample is topped up to a tenth of it from the documents not yet in it. The
 * top-up is seeded by the corpus name and the ids already chosen, so the same
 * starting point always adds the same documents.
 */
export function drawSpotCheck(
  corpus: string,
  testIds: readonly string[],
  existing: SpotCheck | null
): { spotCheck: SpotCheck; added: string[] } {
  const target = Math.ceil(testIds.length / 10)
  const all = [...testIds].sort()
  if (!existing) {
    const ids = createRng(0, "spot-check", corpus).sample(all, target).sort()
    return {
      spotCheck: {
        note: "Checked by a person whether or not the validator flagged anything. Log each one below.",
        drawnFrom: testIds.length,
        ids,
        log: [],
      },
      added: ids,
    }
  }
  const chosen = [...existing.ids].sort()
  const candidates = all.filter((id) => !chosen.includes(id))
  const added = createRng(0, "spot-check", corpus, ...chosen)
    .sample(candidates, Math.max(0, target - chosen.length))
    .sort()
  if (added.length === 0 && (existing.drawnFrom ?? 0) >= testIds.length)
    return { spotCheck: existing, added }
  return {
    spotCheck: {
      ...existing,
      drawnFrom: Math.max(existing.drawnFrom ?? 0, testIds.length),
      ids: [...chosen, ...added].sort(),
    },
    added,
  }
}
