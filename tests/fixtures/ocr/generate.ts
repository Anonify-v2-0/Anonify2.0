/**
 * Regenerates the committed OCR fixture.
 *
 *   pnpm exec tsx tests/fixtures/ocr/generate.ts
 *
 * The image is committed rather than drawn at test time because how a font
 * rasterizes depends on the fonts the machine has, and the geometry assertions
 * are only worth anything against pixels that do not move. The expected boxes
 * are measured from those pixels here — each word is drawn alone and the extent
 * of its ink recorded — so they are ground truth independent of any OCR engine.
 *
 * Only rerun this to change the fixture, and commit both files together.
 */

import { writeFileSync } from "node:fs"
import path from "node:path"

import { createCanvas } from "@napi-rs/canvas"

const WIDTH = 640
const HEIGHT = 220
const FONT = "44px sans-serif"
/** A pixel darker than this, in any channel, is ink. */
const INK = 160

/** Wide, fixed gaps, so no two words can be read as one. */
const WORDS = [
  { text: "ACCOUNT", x: 40, baseline: 80 },
  { text: "12345678", x: 360, baseline: 80 },
  { text: "Patient", x: 40, baseline: 170 },
  { text: "Smith", x: 360, baseline: 170 },
]

type Box = { x: number; y: number; width: number; height: number }

function draw(words: typeof WORDS) {
  const canvas = createCanvas(WIDTH, HEIGHT)
  const context = canvas.getContext("2d")
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, WIDTH, HEIGHT)
  context.fillStyle = "#000000"
  context.font = FONT
  for (const word of words) context.fillText(word.text, word.x, word.baseline)
  return { canvas, context }
}

function inkBox(word: (typeof WORDS)[number]): Box {
  const { context } = draw([word])
  const { data } = context.getImageData(0, 0, WIDTH, HEIGHT)

  let x0 = WIDTH
  let y0 = HEIGHT
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 4
      if (Math.min(data[at], data[at + 1], data[at + 2]) >= INK) continue
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  if (x1 < 0) throw new Error(`"${word.text}" left no ink`)

  // Exclusive right and bottom edges, the convention OCR boxes use.
  return { x: x0, y: y0, width: x1 + 1 - x0, height: y1 + 1 - y0 }
}

const here = import.meta.dirname
const { canvas } = draw(WORDS)
writeFileSync(path.join(here, "account.png"), canvas.toBuffer("image/png"))
writeFileSync(
  path.join(here, "account.json"),
  `${JSON.stringify(
    {
      width: WIDTH,
      height: HEIGHT,
      words: WORDS.map((word) => ({ text: word.text, box: inkBox(word) })),
    },
    null,
    2
  )}\n`
)

console.log(`Wrote account.png and account.json to ${here}`)
