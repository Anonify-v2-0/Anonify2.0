import { decodeText } from "@/lib/documents/delimited/parse"
import { TextStreamBuilder } from "@/lib/documents/shared/text"
import type { NormalizedDocument, NormalizedPage } from "@/types/document"

/**
 * Plain text extraction.
 *
 * The canonical address of anything in a text file is its offset in that file.
 * Nothing else is stable: pages here are a review convenience, invented by us,
 * and inventing page geometry and then treating it as the source of truth is
 * how a redaction ends up pointing at a coordinate that exists nowhere in the
 * document it is supposed to edit.
 *
 * So every span carries its absolute offset in its id — `text#1042` is the
 * line that starts at character 1042 of the original — and the exporter works
 * in those offsets. Pagination can then be changed, or removed, without moving
 * a single redaction.
 */

/** Page geometry the viewer lays out in, matching the DOCX renderer. */
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

/**
 * Characters per page. Deterministic, and it breaks on line boundaries so a
 * value is never split across two pages by pagination alone.
 */
export const CHARS_PER_PAGE = 3_000

/** Refuse a file that would page out to something nobody can review. */
export const MAX_TEXT_CHARS = 8_000_000

export const TEXT_ADDRESS_PREFIX = "text"

/** `text#1042` — the span that begins at character 1042 of the source. */
export function textAddress(offset: number): string {
  return `${TEXT_ADDRESS_PREFIX}#${offset}`
}

/** The absolute source offset an address names, or null if it names none. */
export function parseTextAddress(id: string): number | null {
  const match = new RegExp(`^${TEXT_ADDRESS_PREFIX}#(\\d+)$`).exec(id)
  return match ? Number(match[1]) : null
}

export type TextLine = {
  /** Absolute offset of the line's first character in the source text. */
  start: number
  text: string
}

/** Splits into lines, keeping each line's offset in the original string. */
export function linesOf(text: string): TextLine[] {
  const lines: TextLine[] = []
  const pattern = /\r\n|\r|\n/g

  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    lines.push({ start: cursor, text: text.slice(cursor, match.index) })
    cursor = match.index + match[0].length
  }
  lines.push({ start: cursor, text: text.slice(cursor) })

  return lines
}

/**
 * Groups lines into pages of roughly `CHARS_PER_PAGE`.
 *
 * A line longer than a whole page gets a page to itself and overflows it,
 * which is the honest rendering of a file with no line breaks in it.
 */
export function paginateText(text: string): NormalizedPage[] {
  const lines = linesOf(text)
  const pages: NormalizedPage[] = []

  let builder = new TextStreamBuilder()
  let used = 0

  const flush = () => {
    pages.push({
      number: pages.length + 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      text: builder.text,
      spans: builder.spans,
    })
    builder = new TextStreamBuilder()
    used = 0
  }

  for (const line of lines) {
    if (used > 0 && used + line.text.length > CHARS_PER_PAGE) flush()

    // A blank line contributes no span — there is nothing there to redact —
    // but it still occupies its newline in the page's text stream.
    if (line.text.length > 0) {
      builder.append(textAddress(line.start), line.text)
    }
    builder.pad("\n")
    used += line.text.length + 1
  }

  if (builder.text.length > 0 || pages.length === 0) flush()

  return pages
}

export type TextExtraction = {
  document: NormalizedDocument
  /** The decoded source, so callers do not decode it twice. */
  text: string
}

export function extractText(
  documentId: string,
  bytes: Uint8Array
): TextExtraction {
  const { text, bom } = decodeText(bytes)

  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(
      `File holds more than ${MAX_TEXT_CHARS} characters, which is beyond what can be reviewed`
    )
  }

  const pages = paginateText(text)

  return {
    text,
    document: {
      documentId,
      kind: "txt",
      pages,
      metadata: {
        characters: text.length,
        lines: linesOf(text).length,
        byteOrderMark: bom,
        pageCount: pages.length,
      },
    },
  }
}
