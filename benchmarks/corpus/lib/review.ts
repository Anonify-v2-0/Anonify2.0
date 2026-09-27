import { z } from "zod"

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
