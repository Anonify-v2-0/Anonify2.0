/**
 * Pre-downloads the Tesseract language model.
 *
 *   pnpm ocr:warm
 *
 * tesseract.js fetches roughly 5 MB the first time it reads anything. Left to
 * happen on demand, that download lands in the middle of a user's first
 * redaction and looks like the app has hung. Doing it during setup makes the
 * cost visible at a moment when waiting is expected.
 *
 * Safe to run repeatedly: an already-cached model is not fetched again.
 */

import { existsSync } from "node:fs"
import path from "node:path"

import { cachePath } from "@/lib/ocr/tesseract"
import { selectOcrProvider } from "@/lib/ocr"

async function main(): Promise<void> {
  const { provider } = selectOcrProvider()

  if (provider.name !== "tesseract") {
    console.log(
      `\n  OCR_PROVIDER is "${provider.name}", which needs no local model. Nothing to do.\n`
    )
    return
  }

  const directory = cachePath()
  const model = path.join(directory, "eng.traineddata")

  if (existsSync(model)) {
    console.log(`\n  Already cached: ${model}\n`)
    return
  }

  console.log(`\n  Downloading the English model into ${directory} …`)
  console.log("  About 5 MB, once.\n")

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
    existsSync(model)
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
