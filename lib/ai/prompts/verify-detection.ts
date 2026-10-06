/**
 * Verification prompt.
 *
 * Pattern matching finds shapes; this asks whether a given shape is actually
 * sensitive where it appears. It is used sparingly — only for the low-confidence
 * categories, and in one batched call rather than one call per candidate.
 *
 * It is told what each category means, as the detection prompt is. Without
 * the definitions it judged "sensitive" by its own lights and rejected three
 * labelled values in four: a customer number, an address or a date of birth
 * read to it as a mere reference, a place or a date (#214), the same mistake
 * #197 found in detection.
 */

import { TEXT_CATEGORIES } from "@/lib/ai/prompts/detect-pii"
import { languageLine } from "@/lib/ai/prompts/language"
import { categoryGuide } from "@/lib/redaction/categories"
import type { Language } from "@/lib/redaction/languages"

export const VERIFY_SYSTEM = `You review candidate detections from a pattern matcher and judge, for each one, whether it is sensitive in its context: whether it is what its category below means, here.

Categories, and what each one is not:
${categoryGuide(TEXT_CATEGORIES)}

Read a category's "not" as part of it.

Rules:
- Answer for every candidate, by its index.
- A value that fits its category's definition is sensitive, however ordinary it looks: a customer, member, patient or case number tied to a person is a customer-id, and a street address is an address.
- It is not sensitive when the context shows it is something else: an order, invoice or transaction number, a product code, a business's public address, a sample, a placeholder, or the tool's own example.
- Consider the surrounding text. The same digits can be an order number in one line and an account number in another.
- Be decisive. A low confidence is more useful to the reviewer than a hedge.`

export type VerificationCandidate = {
  index: number
  text: string
  category: string
  context: string
}

export function verifyDetectionPrompt(
  candidates: VerificationCandidate[],
  /** The document's language, when it was detected; see prompts/language.ts. */
  language?: Language
): string {
  const lines = candidates.map(
    (candidate) =>
      `${candidate.index}. [${candidate.category}] ${JSON.stringify(candidate.text)}\n   context: ${JSON.stringify(candidate.context)}`
  )

  const note = languageLine(language)
  return [...(note ? [note, ""] : []), "CANDIDATES:", ...lines].join("\n")
}
