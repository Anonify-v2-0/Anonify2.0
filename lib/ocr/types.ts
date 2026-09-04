/**
 * The OCR contract.
 *
 * Providers differ in how precisely they locate text, and that difference has
 * to travel with the result rather than being flattened away. Tesseract returns
 * a box per *word*; Mistral returns a box per *block* — a paragraph, roughly.
 *
 * A redaction over word-level geometry can cover exactly the characters it
 * matched. Over block-level geometry it cannot: the value sits somewhere inside
 * a multi-line paragraph, and a proportional slice of the paragraph's box would
 * be a rectangle in the wrong place. So the granularity is reported, and
 * anything consuming it redacts the whole block when that is all it knows.
 * Over-redaction is recoverable; a box in the wrong place is a leak.
 */

export type OcrGranularity = "word" | "block"

export type OcrBox = {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type OcrWord = {
  text: string
  /** 0-100, matching Tesseract's scale. */
  confidence: number
  bbox: OcrBox
}

export type OcrResult = {
  words: OcrWord[]
  text: string
  /** How precisely `words[].bbox` locates the text. */
  granularity: OcrGranularity
}

/**
 * A started OCR session. Providers that need expensive setup (a worker, a
 * language model) do it once and reuse it across pages.
 */
export type OcrSession = {
  name: OcrProviderName
  granularity: OcrGranularity
  recognize: (bytes: Uint8Array) => Promise<OcrResult>
  close: () => Promise<void>
}

export const OCR_PROVIDERS = ["tesseract", "mistral"] as const

export type OcrProviderName = (typeof OCR_PROVIDERS)[number]

export type OcrProvider = {
  name: OcrProviderName
  granularity: OcrGranularity
  /** Whether the provider can run without an external service. */
  local: boolean
  start: () => Promise<OcrSession>
  /** Why the provider is unusable right now, or null when it is ready. */
  unavailableReason: () => string | null
}

export const EMPTY_RESULT: OcrResult = {
  words: [],
  text: "",
  granularity: "word",
}
