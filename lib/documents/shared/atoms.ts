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

  // Both lists are in order — atoms by construction, ranges because
  // `mergeRanges` sorts them — so this is a sweep rather than a nested scan.
  // It used to be one loop inside the other, which is fine for a paragraph and
  // quadratic for a document: a large RTF is hundreds of thousands of atoms,
  // and a document with a few hundred accepted values would have spent longer
  // pairing them up than parsing the file.
  //
  // The cursor is left on the last atom that overlapped rather than past it,
  // because one long literal can span the end of one range and the start of
  // the next.
  let cursor = 0

  for (const cut of cuts) {
    const range = cut.textRange

    while (cursor < atoms.length && atoms[cursor].textEnd <= range.start) {
      cursor += 1
    }

    for (let index = cursor; index < atoms.length; index++) {
      const atom = atoms[index]
      if (atom.textStart >= range.end) break
      if (atom.kind === "structural") continue

      if (atom.kind === "escape") {
        cut.ranges.push({ start: atom.start, end: atom.end })
        continue
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
    .sort((a, b) => a.range.start - b.range.start)

  // Assembled in one forward pass. Splicing the string once per edit copies
  // the whole document each time, which is unnoticeable for three redactions
  // and quadratic for three thousand.
  const pieces: string[] = []
  let cursor = 0

  for (const edit of edits) {
    const start = Math.max(cursor, edit.range.start)
    if (start > cursor) pieces.push(source.slice(cursor, start))
    pieces.push(edit.text)
    cursor = Math.max(cursor, edit.range.end)
  }

  pieces.push(source.slice(cursor))
  return pieces.join("")
}
