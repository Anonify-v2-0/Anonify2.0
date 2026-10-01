import type { RedactionCategory } from "@/types/redaction"

/**
 * What each category means, in one place.
 *
 * The detection prompt used to hand the model the category names and nothing
 * else, and the default request asked for "health or financial facts". So the
 * model filed clinical details under `confidential` and every amount on an
 * invoice under `financial`, while the benchmark corpus, generated from its
 * own definitions, labelled neither. Two thirds of the false positives in the
 * first model benchmark were that disagreement (#197).
 *
 * `meaning` is the definition both sides read: the detection prompt, and the
 * corpus generator (benchmarks/corpus/lib/prompt.ts), whose prompt is built
 * from it. For the categories the corpus labels, it is the corpus's wording
 * exactly, because a change to that text is a new corpus prompt version and a
 * corpus to regenerate. tests/categories.test.ts holds it to that.
 *
 * `not` is for the app's prompt only: the near misses a model reaches for.
 * The corpus says the same things once, in its rules, rather than per category.
 */
export type CategoryDefinition = {
  meaning: string
  not?: string
}

export const CATEGORY_DEFINITIONS: Record<
  RedactionCategory,
  CategoryDefinition
> = {
  person: {
    meaning: `a private individual's name, in any form ("Priya Raman", "Ms Raman", "Priya")`,
    not: "a job title or role on its own, or a public figure mentioned as a public figure",
  },
  address: {
    meaning:
      "a postal address or a specific enough part of one (street + number, postcode)",
    not: "a city or country on its own, or a public building",
  },
  phone: { meaning: "a phone or fax number" },
  email: { meaning: "an email address" },
  "government-id": {
    meaning: "national ID, SSN, NI number, passport, driving licence, tax ID",
  },
  "bank-account": {
    meaning: "account number, sort code, IBAN, routing number",
  },
  financial: {
    meaning: "card number, salary, a specific person's balance or debt",
    not: "prices, line items, fees, totals or a company's figures; an amount counts only when it is what a specific person earns, owes or holds",
  },
  "date-of-birth": {
    meaning: "a date of birth or an age that identifies someone",
    not: "any other date, however close it sits to a name: the date of a letter, an appointment, a deadline",
  },
  "customer-id": {
    meaning:
      "customer, patient, employee, member or case number tied to a person",
    not: "invoice, order, ticket, product or internal document numbers",
  },
  confidential: {
    meaning: "internal codenames, unreleased figures, trade secrets",
    not: "a person's health (that is health), job titles, or ordinary operational figures and reference numbers",
  },
  "api-key": { meaning: "secrets, tokens, passwords, private keys" },
  url: {
    meaning:
      "a URL that identifies a person (a profile, a personal site, a signed link)",
  },
  face: { meaning: "a person's face in an image" },
  health: {
    meaning:
      "a specific person's health: a diagnosis, symptom, medication, test result, measurement, treatment or disability",
    not: "medical information that is about no one in particular",
  },
  other: {
    meaning: `anything else that identifies a person: licence plate, IP address,
                  a unique description ("the only left-handed surgeon at St Mary's")`,
    not: "anything one of the other categories covers",
  },
}

/** A definition on one line, for prompts that are not laid out in columns. */
export function categoryMeaning(category: RedactionCategory): string {
  return CATEGORY_DEFINITIONS[category].meaning.replace(/\s*\n\s*/g, " ")
}

/**
 * The categories as a block for a prompt: the name, what it is, and what it
 * is not. Text-only categories, unless `face` is asked for.
 */
export function categoryGuide(
  categories: readonly RedactionCategory[]
): string {
  return categories
    .map((category) => {
      const { not } = CATEGORY_DEFINITIONS[category]
      return `- ${category}: ${categoryMeaning(category)}.${not ? ` Not ${not}.` : ""}`
    })
    .join("\n")
}
