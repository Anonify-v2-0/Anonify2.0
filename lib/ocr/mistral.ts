import type {
  OcrProvider,
  OcrResult,
  OcrSession,
  OcrWord,
} from "@/lib/ocr/types"

/**
 * Mistral OCR: the hosted provider, used by the deployed demo.
 *
 * It reads difficult scans considerably better than Tesseract, and it needs no
 * local binary or language data. The trade is geometry: it returns a box per
 * *block* — a paragraph — not per word, and the boxes are in image pixels
 * rather than page units.
 *
 * Both consequences are handled explicitly rather than smoothed over. Boxes are
 * converted to the same top-left pixel space Tesseract reports, and the result
 * is labelled `block`, which tells the redaction geometry to cover the whole
 * block rather than guess at a slice of it.
 */

const MODEL = "mistral-ocr-latest"
/** Mistral's confidence is per block when requested; treat blocks as reliable. */
const BLOCK_CONFIDENCE = 90

type MistralBlock = {
  type: string
  topLeftX: number
  topLeftY: number
  bottomRightX: number
  bottomRightY: number
  content: string
}

type MistralPage = {
  markdown?: string | null
  blocks?: MistralBlock[] | null
}

/** Block types that carry readable text worth reviewing. */
const TEXT_BLOCK_TYPES = new Set([
  "text",
  "title",
  "header",
  "footer",
  "list",
  "caption",
  "aside_text",
  "references",
  "code",
  "equation",
])

export function apiKey(): string | undefined {
  return process.env.MISTRAL_API_KEY?.trim() || undefined
}

/** Turns Mistral's blocks into the word-shaped records the pipeline consumes. */
export function wordsFromBlocks(blocks: MistralBlock[]): OcrWord[] {
  const words: OcrWord[] = []

  for (const block of blocks) {
    if (!TEXT_BLOCK_TYPES.has(block.type)) continue
    const text = block.content?.trim()
    if (!text) continue

    words.push({
      text,
      confidence: BLOCK_CONFIDENCE,
      bbox: {
        x0: block.topLeftX,
        y0: block.topLeftY,
        x1: block.bottomRightX,
        y1: block.bottomRightY,
      },
    })
  }

  return words
}

function dataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
}

export const mistralProvider: OcrProvider = {
  name: "mistral",
  granularity: "block",
  local: false,

  unavailableReason: () =>
    apiKey()
      ? null
      : "MISTRAL_API_KEY is not set. Set it, or use OCR_PROVIDER=tesseract.",

  async start(): Promise<OcrSession> {
    const key = apiKey()
    if (!key) throw new Error("MISTRAL_API_KEY is not set")

    const { Mistral } = await import("@mistralai/mistralai")
    const client = new Mistral({ apiKey: key })

    return {
      name: "mistral",
      granularity: "block",

      async recognize(bytes: Uint8Array): Promise<OcrResult> {
        const response = await client.ocr.process({
          model: MODEL,
          document: { type: "image_url", imageUrl: dataUrl(bytes) },
          // Blocks are the only geometry this API offers; without them a
          // redaction would have text and nowhere to put it.
          includeBlocks: true,
        })

        const pages = (response.pages ?? []) as MistralPage[]
        const blocks = pages.flatMap((page) => page.blocks ?? [])
        const text = pages
          .map((page) => page.markdown ?? "")
          .join("\n")
          .trim()

        return {
          words: wordsFromBlocks(blocks),
          text,
          granularity: "block",
        }
      },

      async close() {
        // Stateless HTTP; nothing to tear down.
      },
    }
  },
}
