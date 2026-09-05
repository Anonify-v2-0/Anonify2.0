import {
  decodeRtf,
  encodeRtf,
  parseRtf,
  type RtfAtom,
} from "@/lib/documents/rtf/parse"
import {
  findOccurrences,
  mergeRanges,
  type CharRange,
} from "@/lib/documents/shared/text"
import type { TextRedactionPlan } from "@/lib/documents/text/redact"

/**
 * RTF redaction.
 *
 * A range of visible text is translated back into the byte ranges that
 * produced it, and only those bytes are removed. A brace, a control word or a
 * paragraph mark is never touched: the output is the input with some
 * characters missing, which is still RTF and still opens.
 *
 * Three kinds of atom, three behaviours:
 *
 *   literal    one byte per character, so a partial cut is sliced exactly.
 *   escape     `\'e9` or `\u233?` — several bytes for one character, so it
 *              goes whole or not at all.
 *   structural `\par`, `\tab` — contributes text so the offsets line up, and
 *              is never removed, because deleting a paragraph mark
 *              restructures the document rather than redacting it.
 *
 * The exporter re-parses rather than trusting a stored map. The parse is
 * deterministic, so it recovers the identical atoms, and there is no second
 * representation to fall out of step with the file.
 */

/** RTF's three characters with syntactic meaning. */
export function escapeRtf(value: string): string {
  return value.replace(/([\\{}])/g, "\\$1")
}

/**
 * One removal, and the byte ranges that carry it out.
 *
 * A value a word processor split across a formatting group produces several
 * disjoint byte ranges. They belong to one redaction, which is why they are
 * grouped: the marker is written once for the value, not once per fragment it
 * was scattered into.
 */
export type RtfCut = {
  textRange: CharRange
  ranges: CharRange[]
}

export function sourceCutsFor(
  atoms: RtfAtom[],
  textRanges: CharRange[]
): RtfCut[] {
  const wanted = mergeRanges(textRanges)
  if (wanted.length === 0) return []

  const cuts: RtfCut[] = wanted.map((textRange) => ({ textRange, ranges: [] }))

  for (const atom of atoms) {
    // Structural atoms produce text so that offsets line up with what a
    // reviewer reads; removing one would change the document's shape.
    if (atom.kind === "structural") continue

    for (const cut of cuts) {
      const range = cut.textRange
      if (atom.textEnd <= range.start || atom.textStart >= range.end) continue

      if (atom.kind === "escape") {
        // One character, several bytes: there is no partial version of it.
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

export function redactRtf(
  bytes: Uint8Array,
  plan: TextRedactionPlan
): Uint8Array {
  const source = decodeRtf(bytes)
  const { text, atoms } = parseRtf(source)

  // The safety net runs over the decoded text, not over the RTF: searching the
  // source would miss every value a word processor split across a formatting
  // group, which is most of them.
  const sweep = plan.values.flatMap((value) => findOccurrences(text, value))
  const cuts = sourceCutsFor(atoms, [...plan.ranges, ...sweep])

  if (cuts.length === 0) return bytes

  const label = plan.label ? escapeRtf(plan.label) : ""

  // Each removal's marker goes at its first fragment, and the edits are
  // applied back to front so the offsets ahead of each one stay valid.
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

  return encodeRtf(result)
}
