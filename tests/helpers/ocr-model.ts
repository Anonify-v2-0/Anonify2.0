import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, it } from "vitest"

import { cachePath } from "@/lib/ocr/tesseract"

/**
 * The Tesseract model the OCR tests read with, pinned.
 *
 * tesseract.js fetches `eng.traineddata` from an unversioned CDN path on first
 * use. A test that depends on that download fails for reasons that have nothing
 * to do with the code, and one that reads with whichever model the CDN serves
 * today can see its boxes move without a line of ours changing. So the suites
 * run only against a cached copy of one exact model, and tesseract.js reads a
 * cached model without touching the network.
 *
 * This is the model tesseract.js 7 downloads by default for the standard
 * variant. Its versioned URL and hash live in tests/fixtures/ocr/model.json,
 * which CI's OCR job reads too, to fetch it into its cache; locally,
 * `pnpm ocr:warm` puts the same file in `.cache/tesseract`.
 */
export const PINNED_OCR_MODEL: {
  language: string
  /** Gzipped, at a versioned URL, so it cannot change underneath us. */
  source: string
  /** Of the decompressed file, which is what tesseract.js caches. */
  sha256: string
} = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "..", "fixtures", "ocr", "model.json"),
    "utf8"
  )
)

const DEFAULTED = [
  "OCR_PROVIDER",
  "OCR_TESSERACT_MODEL",
  "OCR_TESSERACT_LANGUAGE",
]

type ModelState = { ready: true } | { ready: false; reason: string }

function modelState(): ModelState {
  // The standard variant caches at the bare path; see cacheDirectory().
  const file = path.join(
    cachePath(),
    `${PINNED_OCR_MODEL.language}.traineddata`
  )
  if (!existsSync(file)) {
    return {
      ready: false,
      reason: `No OCR model at ${file}. Run \`pnpm ocr:warm\`, or set TESSERACT_CACHE_PATH to a directory holding it.`,
    }
  }

  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex")
  if (sha256 !== PINNED_OCR_MODEL.sha256) {
    return {
      ready: false,
      reason: `The OCR model at ${file} is not the pinned one (sha256 ${sha256}). Replace it with ${PINNED_OCR_MODEL.source}, decompressed.`,
    }
  }

  return { ready: true }
}

/**
 * A suite that needs the real engine.
 *
 * With the pinned model cached, it runs — locally with no flag at all. Without
 * it, it is skipped, so a fresh clone's `pnpm test` still needs no network.
 * `ANONIFY_OCR_TESTS=1` makes the model required instead, which is how the CI
 * job that caches it makes sure a broken cache fails rather than skips.
 */
export function describeWithOcrModel(name: string, suite: () => void): void {
  const state = modelState()
  const required = Boolean(process.env.ANONIFY_OCR_TESTS?.trim())

  if (state.ready) {
    describe(name, () => {
      // The configuration a default install reads with, whatever this shell has.
      const saved = new Map<string, string | undefined>()
      beforeAll(() => {
        for (const variable of DEFAULTED) {
          saved.set(variable, process.env[variable])
          delete process.env[variable]
        }
      })
      afterAll(() => {
        for (const [variable, value] of saved) {
          if (value === undefined) delete process.env[variable]
          else process.env[variable] = value
        }
      })

      suite()
    })
    return
  }

  if (required) {
    describe(name, () => {
      it("has the pinned OCR model", () => {
        throw new Error(state.reason)
      })
    })
    return
  }

  describe.skip(`${name} (${state.reason})`, suite)
}
