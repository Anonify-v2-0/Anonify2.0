import { mkdir } from "node:fs/promises"
import path from "node:path"

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
 * and reuses it across every page of a document.
 */

/**
 * Where the ~5 MB language model is cached.
 *
 * tesseract.js downloads it on first use and, given no path, writes it to the
 * current working directory — which for this app is the repository root. That
 * is how a 5 MB binary ends up committed by an unsuspecting `git add -A`, so
 * the location is always explicit.
 *
 * Serverless filesystems are read-only apart from /tmp; a container or a
 * developer machine gets a gitignored cache directory that survives reinstalls,
 * so the download happens once rather than on every cold start.
 */
export function cachePath(): string {
  const configured = process.env.TESSERACT_CACHE_PATH?.trim()
  if (configured) return configured
  if (process.env.VERCEL) return "/tmp"
  return path.join(process.cwd(), ".cache", "tesseract")
}

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
    const directory = cachePath()

    // tesseract.js writes the model with a plain writeFile and does not create
    // the directory first. The failure is swallowed by its own logger, so the
    // only symptom is the 5 MB being re-downloaded on every single run.
    await mkdir(directory, { recursive: true }).catch(() => undefined)

    const worker = (await createWorker("eng", undefined, {
      cachePath: directory,
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
