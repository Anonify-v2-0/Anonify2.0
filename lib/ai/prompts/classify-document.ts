/**
 * Classification prompt. A cheap first pass over a small sample: what kind of
 * document is this, what language, and how much sensitive material is it likely
 * to hold. The answer steers how much of the document is worth sending on.
 */

export const CLASSIFY_SYSTEM = `You classify documents so a redaction tool can decide how much analysis they need.

Answer only from the sample you are given. If the sample is too thin to tell, say so in the notes and give a conservative sensitivity estimate rather than guessing a specific document type.`

export function classifyPrompt(sample: string): string {
  return [
    "Classify this document from the opening sample below.",
    "",
    "SAMPLE:",
    sample,
  ].join("\n")
}
