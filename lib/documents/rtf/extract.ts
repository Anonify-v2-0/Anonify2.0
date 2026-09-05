import { decodeRtf, parseRtf } from "@/lib/documents/rtf/parse"
import { MAX_TEXT_CHARS, paginateText } from "@/lib/documents/text/extract"
import type { NormalizedDocument } from "@/types/document"

/**
 * RTF extraction.
 *
 * The parse produces visible text and the map back to the bytes it came from;
 * everything after that is the plain-text pipeline. Spans are addressed by
 * their offset in the decoded text, which is the same convention
 * lib/documents/text uses and is what lets one plan builder serve both — the
 * only difference is what "the source" means on the way out, and that is the
 * redactor's business rather than the reviewer's.
 */

export type RtfExtraction = {
  document: NormalizedDocument
  /** The decoded visible text, so callers do not parse twice. */
  text: string
}

export function extractRtf(
  documentId: string,
  bytes: Uint8Array
): RtfExtraction {
  const { text, atoms } = parseRtf(decodeRtf(bytes))

  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(
      `File holds more than ${MAX_TEXT_CHARS} characters of text, which is beyond what can be reviewed`
    )
  }

  const pages = paginateText(text)

  return {
    text,
    document: {
      documentId,
      kind: "rtf",
      pages,
      metadata: {
        characters: text.length,
        atoms: atoms.length,
        pageCount: pages.length,
      },
    },
  }
}
