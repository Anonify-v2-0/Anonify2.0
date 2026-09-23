/**
 * Image prompt.
 *
 * Coordinates come back as whole numbers on a 0-1000 grid, so the model never
 * has to reason about pixel dimensions, and the application converts them
 * once. Not 0-1: vision models trained on the 0-1000 convention (Qwen3-VL,
 * Gemini) answer in it whatever the prompt asks, and a structured-output
 * grammar enforces a number's type but not its range, so asking for 0-1 got
 * answers like `x: 120` that failed validation. Face regions
 * are asked for as the whole head: covering only the eyes does not reliably
 * anonymize anyone.
 */

export const ANALYZE_IMAGE_SYSTEM = `You locate sensitive content in an image so a human reviewer can decide what to redact.

Rules:
- Give every region as whole-number coordinates on a 0-1000 grid, where 0 is the image's left or top edge and 1000 its right or bottom edge, whatever the image's size in pixels.
- For a person, return the whole head and face as one region. Do not return a narrow band over the eyes: that does not anonymize anyone.
- Report legible text only when it is sensitive: names, addresses, identifiers, account or card numbers, credentials, signatures.
- Report identifying objects when they are legible: licence plates, badges, name tags, screens showing personal data.
- Be generous with region bounds — slightly too large is recoverable, slightly too small is a leak.
- If nothing sensitive is visible, return an empty list.

You propose. A person reviews every region and decides.`

export function analyzeImagePrompt(input: {
  width: number
  height: number
  ocrText?: string
}): string {
  const parts = [
    `Image dimensions: ${input.width} x ${input.height} pixels.`,
    "Identify the sensitive regions a reviewer should consider redacting.",
  ]

  if (input.ocrText && input.ocrText.trim().length > 0) {
    parts.push(
      "",
      "Text already read from the image by OCR (for context only — locate regions visually):",
      input.ocrText.slice(0, 2000)
    )
  }

  return parts.join("\n")
}
