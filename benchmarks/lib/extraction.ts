import type { RenderFormat } from "../corpus/lib/render"
import type { Detected } from "./scoring"
import type { NormalizedDocument } from "@/types/document"
import type { Detection } from "@/types/redaction"

/**
 * From a rendered file back to the labels.
 *
 * A rendered document goes through the extractor an upload of that format
 * goes through, and the pipeline's detections come back as offsets into
 * extracted pages, or as whole spreadsheet cells and columns. Extraction
 * reflows lines, adds headers, drops quotes and commas, so those offsets are
 * not the label offsets. #57 settles it: match by overlap in the normalized
 * text. So the extracted text is aligned with the original, character by
 * character, and each detection is carried back through the alignment.
 *
 * A detection over text the original does not have (an EML header the
 * renderer wrote) maps to nothing and is counted apart, not as a false
 * positive: the document never said it.
 */

/** Runs the extractor the app uses for this format. */
export async function extract(
  documentId: string,
  format: RenderFormat,
  bytes: Uint8Array
): Promise<NormalizedDocument> {
  switch (format) {
    case "txt": {
      const { extractText } = await import("@/lib/documents/text/extract")
      return extractText(documentId, bytes).document
    }
    case "eml": {
      const { extractEml } = await import("@/lib/documents/eml/extract")
      return extractEml(documentId, bytes).document
    }
    case "pdf": {
      // No OCR: every rendered page carries text, and OCR has its own fixtures.
      const { extractPdf } = await import("@/lib/documents/pdf/extract")
      return (await extractPdf(documentId, bytes, { ocr: false })).document
    }
    case "docx": {
      const { extractDocx } = await import("@/lib/documents/docx/extract")
      return extractDocx(documentId, bytes).document
    }
    case "csv": {
      const { extractDelimited } =
        await import("@/lib/documents/delimited/extract")
      return extractDelimited(documentId, "csv", bytes).document
    }
    case "xlsx": {
      const { extractXlsx } = await import("@/lib/documents/xlsx/extract")
      return (await extractXlsx(documentId, bytes)).document
    }
  }
}

// --- alignment --------------------------------------------------------------

/** Characters in a run that must occur exactly once on each side to anchor. */
const UNIQUE = 12
/** Characters in a run that resynchronises the alignment inside a gap. */
const RESYNC = 6

function isSpace(ch: string): boolean {
  return /\s/.test(ch)
}

/** Indices into `pairs` of a longest chain increasing in both coordinates. */
function longestChain(pairs: Array<[number, number]>): number[] {
  const tails: number[] = []
  const previous = new Int32Array(pairs.length).fill(-1)
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pairs[tails[mid]][0] < pairs[k][0]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[k] = tails[lo - 1]
    tails[lo] = k
  }
  const chain: number[] = []
  for (let k = tails.at(-1) ?? -1; k !== -1; k = previous[k]) chain.push(k)
  return chain.reverse()
}

/**
 * For each character of `target`, the index of the same character in
 * `source`, or -1.
 *
 * Whitespace is ignored on both sides, since reflowing lines is most of what
 * extraction does. The two are first tied together where a run of twelve
 * characters occurs exactly once in each (the idea behind patience diff), so
 * text extraction adds, like the headers of an email, cannot pull the match
 * out of place. The gaps between those anchors are then matched from both
 * ends, and what is left in the middle by resynchronising on the next short
 * run the two share. What stays unmatched was added, dropped, or replaced.
 */
export function align(source: string, target: string): Int32Array {
  const map = new Int32Array(target.length).fill(-1)
  const s: number[] = []
  const t: number[] = []
  for (let i = 0; i < source.length; i++) if (!isSpace(source[i])) s.push(i)
  for (let j = 0; j < target.length; j++) if (!isSpace(target[j])) t.push(j)
  const S = s.map((i) => source[i]).join("")
  const T = t.map((j) => target[j]).join("")
  const matched = new Int32Array(T.length).fill(-1)

  // 1. Anchors: runs unique on both sides, in an order both agree on.
  const once = (text: string) => {
    const seen = new Map<string, number>()
    for (let k = 0; k + UNIQUE <= text.length; k++) {
      const run = text.slice(k, k + UNIQUE)
      seen.set(run, seen.has(run) ? -1 : k)
    }
    return seen
  }
  const inSource = once(S)
  const pairs: Array<[number, number]> = []
  for (const [run, j] of once(T)) {
    const i = inSource.get(run)
    if (j >= 0 && i !== undefined && i >= 0) pairs.push([i, j])
  }
  pairs.sort((a, b) => a[1] - b[1])
  let lastI = -1
  let lastJ = -1
  for (const k of longestChain(pairs)) {
    const [i, j] = pairs[k]
    for (let d = 0; d < UNIQUE; d++) {
      if (i + d > lastI && j + d > lastJ) {
        matched[j + d] = i + d
        lastI = i + d
        lastJ = j + d
      }
    }
  }

  // 2. The gaps between anchors.
  const fill = (i0: number, i1: number, j0: number, j1: number) => {
    // From the right end, then the left: an insertion is most often at one end.
    while (i1 > i0 && j1 > j0 && S[i1 - 1] === T[j1 - 1]) matched[--j1] = --i1
    while (i0 < i1 && j0 < j1 && S[i0] === T[j0]) matched[j0++] = i0++
    outer: while (i0 < i1 && j0 < j1) {
      if (S[i0] === T[j0]) {
        matched[j0++] = i0++
        continue
      }
      // A few characters dropped or added, confirmed by the next target
      // character following closely: the `,"` a spreadsheet cell loses, far
      // more often than anything else, and a one-character cell such as a row
      // number is followed by more of them.
      const agree = (i: number, j: number) =>
        i < i1 &&
        j < j1 &&
        S[i] === T[j] &&
        (i + 1 >= i1 ||
          j + 1 >= j1 ||
          S.slice(i + 1, Math.min(i1, i + 5)).includes(T[j + 1]))
      for (let k = 1; k <= 8; k++) {
        if (agree(i0 + k, j0)) {
          i0 += k
          continue outer
        }
        if (agree(i0, j0 + k)) {
          j0 += k
          continue outer
        }
      }
      // A run shorter than RESYNC where the gap is shorter: a spreadsheet cell
      // such as "Mara" is a whole gap between two anchors.
      let best: [number, number] | null = null
      for (let b = 0; b <= 2000 && j0 + b < j1; b++) {
        if (best && b >= best[0] + best[1]) break
        const length = Math.min(RESYNC, j1 - j0 - b)
        const at = S.indexOf(T.slice(j0 + b, j0 + b + length), i0)
        if (at === -1 || at + length > i1) continue
        if (!best || at - i0 + b < best[0] + best[1]) best = [at - i0, b]
      }
      if (!best) return
      i0 += best[0]
      j0 += best[1]
    }
  }
  let i = 0
  let j = 0
  for (let k = 0; k <= T.length; k++) {
    if (k < T.length && matched[k] === -1) continue
    const nextI = k < T.length ? matched[k] : S.length
    if (k > j || nextI > i) fill(i, nextI, j, k)
    i = nextI + 1
    j = k + 1
  }

  for (let k = 0; k < T.length; k++)
    if (matched[k] >= 0) map[t[k]] = s[matched[k]]
  return map
}

// --- from detections to source offsets --------------------------------------

type Cell = { start: number; end: number; row: number }

/**
 * The extracted document as one string (pages, then cells in reading order)
 * aligned with the original, and a way back from each detection to it.
 */
export class SourceMap {
  private readonly map: Int32Array
  private readonly pageStart = new Map<number, number>()
  private readonly cells = new Map<string, Cell>()
  private readonly columns = new Map<string, Cell[]>()
  readonly extracted: string

  constructor(source: string, model: NormalizedDocument) {
    let text = ""
    for (const page of [...model.pages].sort((a, b) => a.number - b.number)) {
      this.pageStart.set(page.number, text.length)
      text += `${page.text}\n`
    }
    for (const sheet of model.sheets ?? []) {
      const ordered = [...sheet.cells].sort(
        (a, b) => a.row - b.row || a.column - b.column
      )
      for (const cell of ordered) {
        if (!cell.value) continue
        const entry = {
          start: text.length,
          end: text.length + cell.value.length,
          row: cell.row,
        }
        text += `${cell.value}\n`
        this.cells.set(
          `${sheet.name}\u0000${cell.row}\u0000${cell.column}`,
          entry
        )
        const key = `${sheet.name}\u0000${cell.column}`
        const column = this.columns.get(key)
        if (column) column.push(entry)
        else this.columns.set(key, [entry])
      }
    }
    this.extracted = text
    this.map = align(source, text)
  }

  /** The source range the extracted range [start, end) came from, if any. */
  private back(start: number, end: number, category: string): Detected | null {
    let low = Infinity
    let high = -Infinity
    for (let k = Math.max(0, start); k < Math.min(end, this.map.length); k++) {
      const at = this.map[k]
      if (at < 0) continue
      low = Math.min(low, at)
      high = Math.max(high, at)
    }
    return low === Infinity ? null : { start: low, end: high + 1, category }
  }

  /** A detection in source terms, or null when it lies outside the document. */
  detection(detection: Detection): Detected | null {
    if (detection.worksheet !== undefined && detection.row !== undefined) {
      const cell = this.cells.get(
        `${detection.worksheet}\u0000${detection.row}\u0000${detection.column}`
      )
      return cell
        ? this.confident(
            this.back(cell.start, cell.end, detection.category),
            detection
          )
        : null
    }
    if (detection.start === undefined || detection.end === undefined)
      return null
    const base = this.pageStart.get(detection.page ?? 1)
    if (base === undefined) return null
    return this.confident(
      this.back(
        base + detection.start,
        base + detection.end,
        detection.category
      ),
      detection
    )
  }

  private confident(mapped: Detected | null, detection: Detection) {
    return mapped && { ...mapped, confidence: detection.confidence }
  }

  /**
   * A column the model judged sensitive, as the cells it redacts: every
   * filled one below the header row, which is how the review screen applies
   * a column redaction.
   */
  column(worksheet: string, column: number, category: string): Detected[] {
    return (this.columns.get(`${worksheet}\u0000${column}`) ?? [])
      .filter((cell) => cell.row > 1)
      .flatMap((cell) => this.back(cell.start, cell.end, category) ?? [])
  }

  /**
   * How much of the original's non-whitespace text extraction gave back,
   * within `ranges` (the labelled values, say) or over all of it. Over all of
   * it a CSV scores low for the commas and quotes it drops, which are not
   * content; over the labels, a lost character is a value the pipeline never
   * saw.
   */
  recovered(
    source: string,
    ranges: { start: number; end: number }[] = [
      { start: 0, end: source.length },
    ]
  ): number {
    const seen = new Uint8Array(source.length)
    for (const at of this.map) if (at >= 0) seen[at] = 1
    let total = 0
    let found = 0
    for (const range of ranges) {
      for (let i = range.start; i < range.end; i++) {
        if (isSpace(source[i])) continue
        total++
        found += seen[i]
      }
    }
    return total === 0 ? 1 : found / total
  }
}
