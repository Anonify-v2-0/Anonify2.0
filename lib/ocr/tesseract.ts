import { existsSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"

import {
  tesseractLangPath,
  tesseractLanguage,
  tesseractLanguageCodes,
  tesseractModel,
} from "@/lib/ocr/models"
import type {
  OcrProvider,
  OcrResult,
  OcrSession,
  OcrWord,
} from "@/lib/ocr/types"
import { withCpuSlot } from "@/lib/runtime/cpu-slots"

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
  // Not traced: a resolvable path would copy the build machine's downloaded
  // models into the server output.
  return path.join(
    /* turbopackIgnore: true */ process.cwd(),
    ".cache",
    "tesseract"
  )
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
  return variantDirectory(cachePath())
}

function variantDirectory(base: string): string {
  const variant = tesseractModel()
  // A download cache, not something to ship: without the ignore, Turbopack
  // cannot resolve the path and traces the whole project into the output.
  return variant === "standard"
    ? base
    : path.join(/* turbopackIgnore: true */ base, variant)
}

/** Where a given language's model lands on disk, for `pnpm ocr:warm`. */
export function modelPath(language: string): string {
  return path.join(cacheDirectory(), `${language}.traineddata`)
}

/**
 * The directory to read models from, seeded from the image's baked copy.
 *
 * The container image carries the default model, laid out like the cache, in
 * `TESSERACT_BAKED_PATH` (#178). Without it, every new replica fetched the
 * model from a CDN on its first scanned page, and a cluster with no outbound
 * internet could not read a scan at all.
 *
 * - The baked directory holds every configured language for the configured
 *   variant: read from it in place. It is read-only, and needs to be nothing
 *   else, so this works on a read-only root filesystem with no volume.
 * - It holds some of them: copy those into the cache, which then downloads
 *   only the rest.
 * - It holds none, or there is none: the cache, as before.
 *
 * Per variant, like the cache: a `best` model is never read from where the
 * `standard` one is kept.
 */
export async function modelDirectory(): Promise<string> {
  const cache = cacheDirectory()
  const bakedBase = process.env.TESSERACT_BAKED_PATH?.trim()
  if (!bakedBase) return cache

  const baked = variantDirectory(bakedBase)
  const languages = tesseractLanguageCodes()
  const present = languages.filter((language) =>
    existsSync(
      path.join(/* turbopackIgnore: true */ baked, `${language}.traineddata`)
    )
  )
  if (present.length === languages.length) return baked

  for (const language of present) {
    const target = path.join(
      /* turbopackIgnore: true */ cache,
      `${language}.traineddata`
    )
    if (existsSync(target)) continue
    await mkdir(cache, { recursive: true }).catch(() => undefined)
    const source = path.join(
      /* turbopackIgnore: true */ baked,
      `${language}.traineddata`
    )
    await copyFile(source, target).catch(() => undefined)
  }
  return cache
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
    const directory = await modelDirectory()
    const language = tesseractLanguage()
    const langPath = tesseractLangPath()

    // tesseract.js writes the model with a plain writeFile and does not create
    // the directory first. The failure is swallowed by its own logger, so the
    // only symptom is the 5 MB being re-downloaded on every single run.
    if (directory === cacheDirectory()) {
      await mkdir(directory, { recursive: true }).catch(() => undefined)
    }

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
        // In a CPU slot (#181): Tesseract runs on a worker thread, so ten
        // documents' pages would otherwise all be read at once.
        const { data } = await withCpuSlot(() =>
          worker.recognize(Buffer.from(bytes), {}, { blocks: true })
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
