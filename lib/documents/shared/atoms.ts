import { mergeRanges, type CharRange } from "@/lib/documents/shared/text"

/**
 * Mapping visible text back to the bytes that produced it.
 *
 * Two formats in this codebase have the same shape of problem. RTF splits a
 * value across formatting groups and writes accented characters as escapes;
 * HTML splits it across tags and writes them as entities. In both, the string
 * a reviewer sees does not appear in the source, and editing the source
 * directly is as likely to destroy the markup as the value.
 *
 * Both are solved the same way: parse once into *atoms*, each of which
 * contributes a known slice of visible text and remembers the byte range it
 * came from. The reviewer works in the decoded text; the exporter translates
 * back and removes only the ranges that actually carry characters.
 *
 * The three kinds are the whole of the rule:
 *
 *   literal    one source byte per character, so a partial cut is exact.
 *   escape     several bytes for one character (`\'e9`, `&amp;`), so it goes
 *              whole or not at all — half an escape corrupts what follows.
 *   structural produces text so offsets line up with what a reviewer reads,
 *              and is never removed: deleting a `\par` or a `<br>` changes the
 *              document's shape rather than redacting it.
 */

export type SourceAtomKind = "literal" | "escape" | "structural"

export type SourceAtom = {
  kind: SourceAtomKind
  /** Byte range in the source. */
  start: number
  end: number
  /** Range in the decoded visible text. */
  textStart: number
  textEnd: number
}

/**
 * One removal, and the byte ranges that carry it out.
 *
 * A value the source scattered across several runs produces several disjoint
 * byte ranges. They are grouped because they are one redaction: the marker is
 * written once for the value, not once per fragment it was split into.
 */
export type SourceCut = {
  textRange: CharRange
  ranges: CharRange[]
}

export function sourceCutsFor(
  atoms: SourceAtom[],
  textRanges: CharRange[]
): SourceCut[] {
  const wanted = mergeRanges(textRanges)
  if (wanted.length === 0) return []

  const cuts: SourceCut[] = wanted.map((textRange) => ({
    textRange,
    ranges: [],
  }))

  for (const atom of atoms) {
    if (atom.kind === "structural") continue

    for (const cut of cuts) {
      const range = cut.textRange
      if (atom.textEnd <= range.start || atom.textStart >= range.end) continue

      if (atom.kind === "escape") {
        cut.ranges.push({ start: atom.start, end: atom.end })
        break
      }

      const from = Math.max(atom.textStart, range.start) - atom.textStart
      const to = Math.min(atom.textEnd, range.end) - atom.textStart
      cut.ranges.push({ start: atom.start + from, end: atom.start + to })
    }
  }

  return cuts
    .map((cut) => ({ ...cut, ranges: mergeRanges(cut.ranges) }))
    .filter((cut) => cut.ranges.length > 0)
}

/**
 * Applies cuts to the source, writing each removal's marker at its first
 * fragment. Edits go back to front so the offsets ahead of each stay valid.
 */
export function applyCuts(
  source: string,
  cuts: SourceCut[],
  label: string
): string {
  const edits = cuts
    .flatMap((cut) =>
      cut.ranges.map((range, index) => ({
        range,
        text: index === 0 ? label : "",
      }))
    )
    .sort((a, b) => b.range.start - a.range.start)

  let result = source
  for (const edit of edits) {
    result =
      result.slice(0, edit.range.start) + edit.text + result.slice(edit.range.end)
  }
  return result
}
