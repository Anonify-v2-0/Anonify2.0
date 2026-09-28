import { describeLength } from "./spec"
import type { DocumentSpec } from "./types"

/**
 * The generation prompt, from issue #57.
 *
 * Bump PROMPT_VERSION on any change to the text below: it is recorded on
 * every document so a corpus can say which prompt produced it.
 *
 * Changes from the issue's draft, all in version 1:
 * - `{{URL}}`, `{{IP}}`, `{{SORT_CODE}}` and `{{ROUTING}}` placeholders, so
 *   URLs and IP addresses come from reserved ranges too, and bank details have
 *   locale-appropriate shapes.
 * - Typed identity placeholders ({{NATIONAL_ID}}, {{TAX_ID}}, {{PASSPORT}},
 *   {{DRIVING_LICENCE}}, {{HEALTH_ID}}), so "SSN:" is followed by an SSN.
 * - Any placeholder takes an optional `:person-id` so a value can repeat for
 *   the same person, not only emails.
 * - A rule that people outside the cast are marked up too: without it, models
 *   add attendees and signatories and leave them unlabelled.
 * - An explicit rule that every domain, marked up or not, is under example.com,
 *   example.org or example.net, and that phone numbers and emails are never
 *   written without markup. The script rejects documents that break either.
 */
export const PROMPT_VERSION = "1"

export const SYSTEM_PROMPT = `You write realistic but entirely fictional documents for testing a PII
redaction tool. Every person, organisation, address and identifier you write is
invented. Never use the name of a real, identifiable private individual, and
never use a real public figure except where the spec asks for a public-figure
negative.

You mark up personal data inline AS YOU WRITE IT, using exactly this syntax:

  [[category|value]]

Categories (use only these):
  person          a private individual's name, in any form ("Priya Raman", "Ms Raman", "Priya")
  address         a postal address or a specific enough part of one (street + number, postcode)
  phone           a phone or fax number
  email           an email address
  government-id   national ID, SSN, NI number, passport, driving licence, tax ID
  bank-account    account number, sort code, IBAN, routing number
  financial       card number, salary, a specific person's balance or debt
  date-of-birth   a date of birth or an age that identifies someone
  customer-id     customer, patient, employee, member or case number tied to a person
  confidential    internal codenames, unreleased figures, trade secrets
  api-key         secrets, tokens, passwords, private keys
  url             a URL that identifies a person (a profile, a personal site, a signed link)
  other           anything else that identifies a person: licence plate, IP address,
                  a unique description ("the only left-handed surgeon at St Mary's")

For these, DO NOT invent the value. Write a placeholder and the tool fills it:
  [[phone|{{PHONE}}]]  [[email|{{EMAIL}}]]  [[government-id|{{GOV_ID}}]]
  [[bank-account|{{IBAN}}]]  [[bank-account|{{ACCOUNT}}]]
  [[bank-account|{{SORT_CODE}}]]  [[bank-account|{{ROUTING}}]]
  [[financial|{{CARD}}]]  [[api-key|{{SECRET}}]]  [[url|{{URL}}]]  [[other|{{IP}}]]
When the document says which kind of ID it is, use the matching placeholder
instead of {{GOV_ID}}: {{NATIONAL_ID}} (SSN, NI number, Aadhaar, DNI),
{{TAX_ID}}, {{PASSPORT}}, {{DRIVING_LICENCE}}, {{HEALTH_ID}} (NHS number, Medicare).
For an email address that belongs to a specific person, write
[[email|{{EMAIL:person-id}}]] so it matches their name. Any placeholder takes
":person-id" the same way, and the same placeholder and id always give the same
value, so a person's number or ID can be repeated: [[phone|{{PHONE:p1}}]].

Rules:
- Mark EVERY occurrence, including repeats, possessives ("[[person|Priya]]'s")
  and partial forms. An unmarked real-looking value is a labelling error.
- The cast is who the document is about, not everyone in it. Anyone else you
  name (attendees, signatories, colleagues, people in a transaction list) is
  personal data too and is marked up every time.
- Mark only the value itself, never the label before it: "Phone: [[phone|{{PHONE}}]]".
- Every phone number and email address is personal data here and is always a
  marked-up placeholder, including an organisation's switchboard or shared inbox.
- Every domain, website or URL you write, marked up or not, is under
  example.com, example.org or example.net ("www.harbourline.example.com").
- Do NOT mark things that are not personal data: company names acting as
  companies, product codes, invoice numbers, public buildings, job titles alone,
  dates that are not birthdays, public figures mentioned as public figures.
  These negatives are as important as the positives.
- Write like the real thing: headers, signatures, quoted replies, tables,
  typos, inconsistent formatting. Clean prose is too easy.
- Output JSON only, matching the schema. No commentary.`

export function userPrompt(spec: DocumentSpec): string {
  const cast = spec.cast.length
    ? `[${spec.cast.map((member) => JSON.stringify(member)).join(",\n                  ")}]`
    : "[]"
  return `Write one document.

Type:            ${spec.docTypeDetail}
Locale:          ${spec.locale}   (names, addresses and formats to match)
Length:          ${describeLength(spec)}
PII density:     ${spec.density}
Cast:            ${cast}
Must include:    ${JSON.stringify(spec.mustInclude)}
Hard negatives:  ${JSON.stringify(spec.negatives)}

Use each cast member the number of times given, varying how they are referred
to (full name, first name, title and surname, initials). If density is "none",
write a document with no personal data at all and include the hard negatives.${
    spec.docType === "tabular export"
      ? "\n\nThe body is the raw CSV itself: a header row, then one row per record."
      : ""
  }

Return:
{
  "title": string,
  "docType": string,
  "locale": string,
  "cast": [{ "id": string, "name": string }],
  "body": string,                 // the document, with [[category|value]] markup
  "negatives": [string]           // the look-alikes you included, verbatim
}`
}

/** The response schema, for CLIs that can enforce one. */
export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "docType", "locale", "cast", "body", "negatives"],
  properties: {
    title: { type: "string" },
    docType: { type: "string" },
    locale: { type: "string" },
    cast: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
    body: { type: "string" },
    negatives: { type: "array", items: { type: "string" } },
  },
} as const

/**
 * Appended to the prompt of a retry: why the previous draft of this document
 * was rejected. Without it a retry is a fresh draw that tends to repeat the
 * same slip, and in the first full run most rejections were one of a few
 * (an unmarked repeat of a name, a required category left out).
 *
 * It is not part of PROMPT_VERSION: the prompt it follows is unchanged, and a
 * cached response records the note it was written against as `feedback`.
 * A reason naming the operator is replaced with a generic one, so no part of
 * their identity is sent back to the model.
 */
export function retryNote(reasons: string[]): string {
  const lines = [
    ...new Set(
      reasons.map((reason) =>
        reason.startsWith("mentions the operator")
          ? "it uses a real person's name; invent different names"
          : reason.length > 240
            ? `${reason.slice(0, 240)}…`
            : reason
      )
    ),
  ].slice(0, 10)
  return `

Your previous draft of this document was rejected by the checks:
${lines.map((line) => `- ${line}`).join("\n")}

Write it again from the start, following every rule above, and make sure none
of these happens again. Offsets ("at 402") are character positions in the
previous draft's body with the markup removed.`
}
