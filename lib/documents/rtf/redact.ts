import {
  decodeRtf,
  encodeRtf,
  parseRtf,
} from "@/lib/documents/rtf/parse"
import { applyCuts, sourceCutsFor } from "@/lib/documents/shared/atoms"
import { findOccurrences } from "@/lib/documents/shared/text"
import type { TextRedactionPlan } from "@/lib/documents/text/redact"

/**
 * RTF redaction.
 *
 * A range of visible text is translated back into the byte ranges that
 * produced it, and only those bytes are removed. A brace, a control word or a
 * paragraph mark is never touched: the output is the input with some
 * characters missing, which is still RTF and still opens.
 *
 * The translation itself is not RTF-specific — HTML inside an email has the
 * same problem and the same answer — so it lives in
 * lib/documents/shared/atoms.ts. What is RTF-specific is which pieces of the
 * file count as literals, as escapes, and as structure, and that is decided by
 * the parser.
 *
 * The exporter re-parses rather than trusting a stored map. The parse is
 * deterministic, so it recovers the identical atoms, and there is no second
 * representation to fall out of step with the file.
 */

/** RTF's three characters with syntactic meaning. */
export function escapeRtf(value: string): string {
  return value.replace(/([\\{}])/g, "\\$1")
}

export { sourceCutsFor }

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

  return encodeRtf(
    applyCuts(source, cuts, plan.label ? escapeRtf(plan.label) : "")
  )
}
