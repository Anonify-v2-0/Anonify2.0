/**
 * Where each character of a PDF text run actually sits.
 *
 * pdf.js reports text as runs, often a whole line at a time, with the width of
 * the run and nothing finer. A redaction covers some characters in the middle
 * of one, so their position has to be worked out, and the obvious answer
 * (the run's width divided evenly between its characters) is exact only for
 * monospace text. In proportional type a `W` is three times an `i`, the error
 * accumulates along the line, and the box lands characters away from the
 * value it was meant to cover. That box is what the export burns in.
 *
 * The widths used here are the font's own, as pdf.js hands them to the painter:
 * every glyph in the page's operator list carries its advance. They are laid
 * end to end at the run's scale, and whatever they do not explain (the word
 * spacing of justified text, character spacing, a gap pdf.js turned into a
 * space) is put where it most plausibly went. The last offset is always the
 * run's measured width, so both ends are exact.
 */

type Glyph = { unicode?: string; width?: number } | number | null

/** Advance widths by character, per font, in glyph units (1000 to the em). */
export type FontWidths = Map<string, Map<string, number>>

/** Leftover width below this share of the run is rounding, not spacing. */
const RESIDUE_TOLERANCE = 0.01

const WHITESPACE = /\s/

/**
 * Collects every glyph advance the page paints, keyed by the font it was
 * painted in. The key is the same `loadedName` that text content reports as
 * an item's `fontName`, so a run can look up its own font.
 */
export function collectFontWidths(
  ops: Record<string, number>,
  operatorList: { fnArray: number[]; argsArray: unknown[] }
): FontWidths {
  const fonts: FontWidths = new Map()
  const showOps = new Set(
    [
      ops.showText,
      ops.showSpacedText,
      ops.nextLineShowText,
      ops.nextLineSetSpacingShowText,
    ].filter((op): op is number => typeof op === "number")
  )

  let current: Map<string, number> | undefined

  operatorList.fnArray.forEach((fn, index) => {
    const args = operatorList.argsArray[index] as unknown[] | null
    if (fn === ops.setFont) {
      const name = String(args?.[0] ?? "")
      current = fonts.get(name) ?? new Map()
      fonts.set(name, current)
      return
    }
    if (!current || !showOps.has(fn)) return

    // pdf.js normalises every show operator to one glyph array, last.
    const glyphs = args?.[args.length - 1]
    if (!Array.isArray(glyphs)) return

    for (const glyph of glyphs as Glyph[]) {
      if (!glyph || typeof glyph !== "object") continue
      const { unicode, width } = glyph
      if (!unicode || typeof width !== "number" || !(width >= 0)) continue

      // Text content is NFKC-normalised, so a ligature arrives there as the
      // letters it stands for. Share its advance between them.
      const chars = [...unicode.normalize("NFKC")]
      for (const char of chars) {
        if (!current.has(char)) current.set(char, width / chars.length)
      }
    }
  })

  return fonts
}

/**
 * Character start positions across a horizontal run, plus its end:
 * `text.length + 1` values from 0 to `width`, indexed by UTF-16 code unit like
 * every other offset in the text stream.
 *
 * `scale` is the run's horizontal scale from text space to the page (font size
 * times horizontal scaling), which turns glyph units into page units.
 *
 * `null` when the font's widths are unknown for most of the run. A guess is
 * then no better than the even split, and the caller covers the whole run
 * instead, which is visible on the canvas where a misplaced box is not.
 */
export function characterOffsets(
  text: string,
  width: number,
  scale: number,
  widths: Map<string, number> | undefined
): number[] | null {
  const chars = [...text]
  if (chars.length === 0 || !(width > 0) || !(scale > 0)) return null
  if (!widths || widths.size === 0) return null

  const printable = chars.filter((char) => !WHITESPACE.test(char))
  if (printable.length === 0) {
    // Nothing is inked, so there is nothing a split could misplace.
    return [...text, ""].map((_, i) => (width * i) / text.length)
  }
  const known = printable.filter((char) => widths.has(char))
  if (known.length === 0 || known.length < printable.length / 2) return null

  const mean =
    known.reduce((sum, char) => sum + (widths.get(char) ?? 0), 0) / known.length

  // A space pdf.js inserted for a gap has no glyph behind it, so an unknown
  // space starts at zero and gets its width from the residue below.
  const advances = chars.map((char) => {
    const glyph = widths.get(char) ?? (WHITESPACE.test(char) ? 0 : mean)
    return (glyph / 1000) * scale
  })

  const natural = advances.reduce((sum, value) => sum + value, 0)
  const residue = width - natural
  const spaces = chars.filter((char) => WHITESPACE.test(char)).length

  if (Math.abs(residue) <= width * RESIDUE_TOLERANCE && natural > 0) {
    // Nothing but rounding: stretch to fit.
    const stretch = width / natural
    for (let i = 0; i < advances.length; i++) advances[i] *= stretch
  } else if (residue > 0 && spaces > 0) {
    // Justified text, or a gap that became a space: the width went between
    // words, not between letters.
    const share = residue / spaces
    chars.forEach((char, i) => {
      if (WHITESPACE.test(char)) advances[i] += share
    })
  } else {
    // Character spacing, or kerning that tightened the run.
    const share = residue / chars.length
    for (let i = 0; i < advances.length; i++) advances[i] += share
  }

  const offsets = [0]
  let x = 0
  chars.forEach((char, i) => {
    // A character outside the BMP is two code units; the second one starts
    // where the first does.
    if (char.length === 2) offsets.push(x)
    x += advances[i]
    offsets.push(x)
  })
  offsets[offsets.length - 1] = width
  return offsets
}
