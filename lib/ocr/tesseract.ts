import type {
  OcrProvider,
  OcrResult,
  OcrSession,
  OcrWord,
} from "@/lib/ocr/types"

/**
 * Tesseract: the local provider.
 *
 * Runs entirely on the machine, needs no account, and returns a box per word —
 * the precision the redaction geometry actually wants. It is the default for a
 * self-hosted install for both reasons.
 *
 * Starting a worker costs far more than reading a page, so a session starts one
 * and reuses it across every page of a document. Language data lands in /tmp on
 * serverless filesystems, which are read-only everywhere else.
 */

type Recognizer = {
  recognize: (
    image: Buffer,
    options?: unknown,
    output?: unknown
  ) => Promise<{ data: { text?: string; blocks?: unknown } }>
  terminate: () => Promise<unknown>
}

type TesseractBlock = {
  paragraphs?: { lines?: { words?: OcrWord[] }[] }[]
}

function wordsOf(data: { blocks?: unknown }): OcrWord[] {
  const words: OcrWord[] = []
  for (const block of (data.blocks ?? []) as TesseractBlock[]) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          words.push({
            text: word.text,
            confidence: word.confidence,
            bbox: word.bbox,
          })
        }
      }
    }
  }
  return words
}

export const tesseractProvider: OcrProvider = {
  name: "tesseract",
  granularity: "word",
  local: true,

  unavailableReason: () => null,

  async start(): Promise<OcrSession> {
    const { createWorker } = await import("tesseract.js")
    const worker = (await createWorker("eng", undefined, {
      cachePath: process.env.VERCEL ? "/tmp" : undefined,
    })) as unknown as Recognizer

    return {
      name: "tesseract",
      granularity: "word",

      async recognize(bytes: Uint8Array): Promise<OcrResult> {
        const { data } = await worker.recognize(
          Buffer.from(bytes),
          {},
          { blocks: true }
        )
        return {
          words: wordsOf(data),
          text: data.text ?? "",
          granularity: "word",
        }
      },

      async close() {
        await worker.terminate()
      },
    }
  },
}
