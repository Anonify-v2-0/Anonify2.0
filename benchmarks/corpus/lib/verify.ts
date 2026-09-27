import {
  isReservedEmail,
  isReservedPhone,
  isReservedUrl,
  scanForIdentifiers,
  UNRESERVED_PHONE_LOCALES,
} from "./reserved"
import { isCategory, type LabelledDocument } from "./types"

/**
 * The checks `pnpm corpus:check` holds every committed corpus file to. They
 * read only the file, so they hold for a file edited by hand as much as for
 * one the generator wrote.
 */

const KIND_CATEGORY = {
  email: "email",
  phone: "phone",
  url: "url",
  ip: "other",
} as const

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number }
) {
  return a.start < b.end && a.end > b.start
}

export function checkDocument(document: LabelledDocument): string[] {
  const problems: string[] = []
  const { text } = document
  if (typeof text !== "string") return ["has no text"]
  const spans = Array.isArray(document.spans) ? document.spans : []
  const negatives = Array.isArray(document.negatives) ? document.negatives : []

  // Labels line up with the text, and do not overlap each other.
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  for (const [index, span] of ordered.entries()) {
    if (!isCategory(span.category))
      problems.push(
        `span at ${span.start} has unknown category "${span.category}"`
      )
    if (!(
      span.start >= 0 &&
      span.end > span.start &&
      span.end <= text.length
    )) {
      problems.push(`span at ${span.start}–${span.end} is outside the text`)
      continue
    }
    if (text.slice(span.start, span.end) !== span.value) {
      problems.push(
        `span at ${span.start} says ${JSON.stringify(span.value)} but the text there is ${JSON.stringify(text.slice(span.start, span.end))}`
      )
    }
    const previous = ordered[index - 1]
    if (previous && overlaps(previous, span))
      problems.push(`spans at ${previous.start} and ${span.start} overlap`)
  }
  for (const negative of negatives) {
    if (text.slice(negative.start, negative.end) !== negative.value) {
      problems.push(`negative at ${negative.start} does not match the text`)
    }
    if (spans.some((span) => overlaps(span, negative)))
      problems.push(`negative at ${negative.start} overlaps a labelled span`)
  }

  // Labelled values of a checkable kind are reserved, or were filled by the
  // generator in a locale that has no reserved range.
  for (const span of spans) {
    if (
      span.category === "email" &&
      /@/.test(span.value) &&
      !isReservedEmail(span.value)
    ) {
      problems.push(
        `labelled email ${JSON.stringify(span.value)} is not at a reserved domain`
      )
    }
    if (span.category === "phone" && !isReservedPhone(span.value)) {
      const filledWhereNoneReserved =
        span.placeholder === "PHONE" &&
        UNRESERVED_PHONE_LOCALES.includes(document.locale)
      if (!filledWhereNoneReserved)
        problems.push(
          `labelled phone ${JSON.stringify(span.value)} is not in a reserved range`
        )
    }
    if (
      span.category === "url" &&
      /[./]/.test(span.value) &&
      !isReservedUrl(span.value)
    ) {
      problems.push(
        `labelled URL ${JSON.stringify(span.value)} is not at a reserved domain`
      )
    }
  }

  // And nothing unreserved anywhere else in the text.
  for (const finding of scanForIdentifiers(text)) {
    if (finding.reserved) continue
    // Only a label that covers the whole finding can speak for it; one that
    // merely overlaps ("[[email|john]]@gmail.com") leaves the rest unjudged.
    const inside = spans.filter(
      (span) => span.start <= finding.start && finding.end <= span.end
    )
    // An email, phone or URL label was judged by its own value above. An IP
    // labelled "other" was not, so it gets no pass here.
    if (
      finding.kind !== "ip" &&
      inside.some((span) => span.category === KIND_CATEGORY[finding.kind])
    )
      continue
    // Digits inside a generated IBAN or card number can look like a phone
    // number, and a generated token can look like a domain. A generated value
    // is never excused as its own kind.
    if (
      inside.some(
        (span) =>
          span.placeholder && span.category !== KIND_CATEGORY[finding.kind]
      )
    )
      continue
    problems.push(
      `${finding.kind} outside the reserved ranges at ${finding.start}: ${JSON.stringify(finding.value)}`
    )
  }

  for (const [field, value] of [
    ["title", document.title],
    ...(document.entities ?? []).map(
      (entity) => ["entity name", entity.name] as const
    ),
  ] as const) {
    for (const finding of scanForIdentifiers(String(value ?? ""))) {
      if (!finding.reserved)
        problems.push(
          `${field} contains a ${finding.kind} outside the reserved ranges`
        )
    }
  }

  return problems
}
