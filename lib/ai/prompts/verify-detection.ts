/**
 * Verification prompt.
 *
 * Pattern matching finds shapes; this asks whether a given shape is actually
 * sensitive where it appears. It is used sparingly — only for the low-confidence
 * categories, and in one batched call rather than one call per candidate.
 */

import { languageLine } from "@/lib/ai/prompts/language"
import type { Language } from "@/lib/redaction/languages"

export const VERIFY_SYSTEM = `You review candidate detections from a pattern matcher and judge whether each one is genuinely sensitive in its context.

Rules:
- Answer for every candidate, by its index.
- A value that is clearly a public reference, a sample, a placeholder, or the tool's own example is not sensitive.
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
