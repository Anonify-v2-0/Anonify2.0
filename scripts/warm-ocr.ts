/**
 * Pre-downloads the Tesseract language model.
 *
 *   pnpm ocr:warm
 *
 * tesseract.js fetches several megabytes the first time it reads anything. Left
 * to happen on demand, that download lands in the middle of a user's first
 * redaction and looks like the app has hung. Doing it during setup makes the
 * cost visible at a moment when waiting is expected.
 *
 * It warms *what is configured* — the variant chosen by OCR_TESSERACT_MODEL and
 * every language in OCR_TESSERACT_LANGUAGE. Warming `eng` at the default
 * variant regardless, which is what it used to do, is worse than not warming at
 * all: it reports success, and then the first real page downloads the model
 * that was actually needed anyway.
 *
 * Safe to run repeatedly: an already-cached model is not fetched again.
 */

// Loaded first, so every module below sees the configured environment. A CLI
// gets no .env for free the way the Next server does, and without this the
// database simply appears to be unset.
import "dotenv/config"

import { existsSync } from "node:fs"

import {
  TESSERACT_MODEL_DETAIL,
  tesseractLanguageCodes,
  tesseractModel,
} from "@/lib/ocr/models"
import { cacheDirectory, modelPath } from "@/lib/ocr/tesseract"
import { selectOcrProvider } from "@/lib/ocr"

async function main(): Promise<void> {
  const { provider } = selectOcrProvider()

  if (provider.name !== "tesseract") {
    console.log(
      `\n  OCR_PROVIDER is "${provider.name}", which needs no local model. Nothing to do.\n`
    )
    return
  }

  const directory = cacheDirectory()
  const variant = tesseractModel()
  const languages = tesseractLanguageCodes()
  const files = languages.map((language) => modelPath(language))

  if (files.every((file) => existsSync(file))) {
    console.log(`\n  Already cached: ${files.join(", ")}\n`)
    return
  }

  const { approxMb, summary } = TESSERACT_MODEL_DETAIL[variant]
  console.log(
    `\n  Downloading the ${variant} model for ${languages.join(", ")} into ${directory} …`
  )
  console.log(`  ${summary}`)
  console.log(`  About ${approxMb} MB per language, once.\n`)

  const started = Date.now()
  const session = await provider.start()

  try {
    // A real, generated image rather than an embedded base64 constant: a
    // hand-written one is a silent corruption waiting to happen, and sharp is
    // already a dependency.
    const sharp = (await import("sharp")).default
    const blank = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer()

    await session.recognize(new Uint8Array(blank))
  } finally {
    await session.close()
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    files.every((file) => existsSync(file))
      ? `  Done in ${seconds}s. OCR will not need the network again.\n`
      : `  Finished in ${seconds}s, but no model was written to ${directory}.\n`
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`\n  Could not warm the OCR model: ${message}`)
  console.error("  It will be downloaded on first use instead.\n")
  // Not fatal: this is a convenience, and OCR still works without it.
})
