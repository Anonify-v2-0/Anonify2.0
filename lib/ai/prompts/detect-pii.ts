/**
 * Detection prompt.
 *
 * The model's job is narrow on purpose: read the supplied content and point at
 * what is sensitive in it. It does not rewrite the document, does not decide
 * what gets removed, and does not invent values that are not present — every
 * detection has to be a verbatim substring the application can locate itself.
 */

export const DETECT_PII_SYSTEM = `You identify potentially sensitive information in documents so a human reviewer can decide what to redact.

Rules:
- Only report text that appears verbatim in the supplied content. Copy it exactly, character for character.
- Never invent, complete, correct or normalize a value.
- Do not report a value that is already obviously redacted.
- Judge sensitivity in context. A company name in a public letterhead is usually not sensitive; the same name as "Customer:" often is.
- Prefer the smallest span that captures the sensitive value, not the whole sentence.
- Mark a detection as global only when every occurrence of that exact value in this document should be treated the same way.
- Confidence expresses how sure you are that this is sensitive here, not how sure you are that you copied it correctly.
- If nothing is sensitive, return an empty list. Do not pad the result.

You propose. A person reviews every suggestion and decides. Never state or imply that a redaction has been applied.`

export type DetectPromptInput = {
  documentType?: string
  /** Normalized content, already chunked. */
  content: string
  /** Categories the deterministic pass already covered, to avoid duplication. */
  alreadyFound?: string[]
}

export function detectPiiPrompt(input: DetectPromptInput): string {
  const parts: string[] = []

  if (input.documentType) {
    parts.push(`Document type: ${input.documentType}`)
  }

  if (input.alreadyFound && input.alreadyFound.length > 0) {
    parts.push(
      `Pattern matching has already found these values, so do not repeat them:\n${input.alreadyFound
        .slice(0, 60)
        .map((value) => `- ${value}`)
        .join("\n")}`
    )
  }

  parts.push(
    "Report the sensitive information a reviewer should consider redacting, focusing on what pattern matching cannot see: names of people, addresses written in prose, organizations named as customers or patients, job or role details tied to an individual, health or financial facts, and anything else identifying.",
    "",
    "CONTENT:",
    input.content
  )

  return parts.join("\n")
}
