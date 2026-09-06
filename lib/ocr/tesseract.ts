import { mkdir } from "node:fs/promises"
import path from "node:path"

import {
  tesseractLangPath,
  tesseractLanguage,
  tesseractModel,
} from "@/lib/ocr/models"
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
 *
 * Which language it reads and how large a model it reads with are configuration
 * — see lib/ocr/models.ts. Nothing here is paced or retried: Tesseract runs on
 * this machine, answers to no rate limit, and the only thing throttling it
 * would achieve is a slower redaction.
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

/**
 * The cache directory for the *configured variant*.
 *
 * tesseract.js names the cached file after the language and nothing else, so
 * `eng.traineddata` from the fast variant and `eng.traineddata` from the best
 * variant are the same filename holding different models. Sharing one directory
 * means switching OCR_TESSERACT_MODEL silently keeps reading with the old one —
 * a setting that appears to take effect and does not, which is the failure this
 * codebase refuses everywhere else.
 *
 * The default variant keeps the bare path it has always had, so an existing
 * install does not re-download 3 MB for a directory rename.
 */
export function cacheDirectory(): string {
  const base = cachePath()
  const variant = tesseractModel()
  return variant === "standard" ? base : path.join(base, variant)
}

/** Where a given language's model lands on disk, for `pnpm ocr:warm`. */
export function modelPath(language: string): string {
  return path.join(cacheDirectory(), `${language}.traineddata`)
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

  unavailableReason: () => {
    // Nothing external can make Tesseract unavailable, but a misconfigured
    // model or language can, and selection is where that is meant to be said —
    // not on page one of somebody's scan.
    try {
      tesseractModel()
      tesseractLanguage()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  },

  async start(): Promise<OcrSession> {
    const { createWorker } = await import("tesseract.js")
    const directory = cacheDirectory()
    const language = tesseractLanguage()
    const langPath = tesseractLangPath()

    // tesseract.js writes the model with a plain writeFile and does not create
    // the directory first. The failure is swallowed by its own logger, so the
    // only symptom is the 5 MB being re-downloaded on every single run.
    await mkdir(directory, { recursive: true }).catch(() => undefined)

    const worker = (await createWorker(language, undefined, {
      cachePath: directory,
      // Undefined rather than null: the library branches on falsiness to pick
      // its own default, and a variant of "standard" is a request for exactly
      // that default rather than for a URL of ours.
      ...(langPath ? { langPath } : {}),
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
