import {
  decodeText,
  encodeText,
  UTF8_BOM,
} from "@/lib/documents/delimited/parse"
import {
  cutRanges,
  findOccurrences,
  type CharRange,
} from "@/lib/documents/shared/text"

/**
 * Plain text redaction.
 *
 * Ranges are absolute offsets into the decoded source, which is what the
 * extractor addressed spans by, so nothing has to be re-derived: the character
 * at offset 1042 now is the character at offset 1042 then.
 *
 * Every byte outside a redacted range survives exactly as it arrived — line
 * endings, trailing whitespace, the byte-order mark. A text file is the one
 * format where "leave the rest alone" is trivially achievable, so anything
 * less would be carelessness.
 */

export type TextRedactionPlan = {
  /** Absolute character ranges in the decoded source. */
  ranges: CharRange[]
  /** Accepted values, removed wherever else they appear. */
  values: string[]
  label: string | null
}

export function redactText(
  bytes: Uint8Array,
  plan: TextRedactionPlan
): Uint8Array {
  const { text, bom } = decodeText(bytes)

  // The safety net, on the same footing as the addressed ranges: a value the
  // reviewer accepted in one place is accepted everywhere it occurs, and in a
  // flat text file the text *is* the structure, so a search over it is a
  // search over the document rather than over its serialization.
  const sweep = plan.values.flatMap((value) => findOccurrences(text, value))

  const redacted = cutRanges(
    text,
    [...plan.ranges, ...sweep],
    () => plan.label ?? ""
  )

  return encodeText(bom ? `${UTF8_BOM}${redacted}` : redacted)
}
