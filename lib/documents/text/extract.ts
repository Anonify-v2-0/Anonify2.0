import { decodeText, TextDecodingStream } from "@/lib/documents/delimited/parse"
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
 *
 * Every stage here — decoding, splitting lines, paginating — works on a piece
 * at a time, so extraction can read a file as it streams out of storage and
 * write each page as it fills. The whole-file functions below are the same
 * stages fed one piece, which is what keeps the two paths from disagreeing.
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

/**
 * Splits text into lines as it arrives, keeping each line's offset in the
 * original string. CRLF, a lone CR and a lone LF all end a line.
 *
 * A CR at the very end of a piece is held back until the next piece says
 * whether an LF follows it, so a CRLF split across two pieces is still one
 * line break. The last line is always reported, even when it is empty — a
 * file ending in a newline has an empty line after it, and always has.
 */
export class LineSplitter {
  private carry = ""
  private carryStart = 0

  constructor(private readonly onLine: (line: TextLine) => void) {}

  write(text: string): void {
    this.split(this.carry + text, false)
  }

  end(): void {
    this.split(this.carry, true)
    this.onLine({ start: this.carryStart, text: this.carry })
    this.carry = ""
  }

  private split(buffer: string, final: boolean): void {
    const pattern = /\r\n|\r|\n/g
    const base = this.carryStart

    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(buffer)) !== null) {
      if (!final && match[0] === "\r" && match.index === buffer.length - 1) {
        break
      }
      this.onLine({
        start: base + cursor,
        text: buffer.slice(cursor, match.index),
      })
      cursor = match.index + match[0].length
    }

    this.carry = buffer.slice(cursor)
    this.carryStart = base + cursor
  }
}

/** Splits into lines, keeping each line's offset in the original string. */
export function linesOf(text: string): TextLine[] {
  const lines: TextLine[] = []
  const splitter = new LineSplitter((line) => lines.push(line))
  splitter.write(text)
  splitter.end()
  return lines
}

/**
 * Groups lines into pages of roughly `CHARS_PER_PAGE`, handing each page over
 * the moment it is full.
 *
 * A line longer than a whole page gets a page to itself and overflows it,
 * which is the honest rendering of a file with no line breaks in it.
 */
export class TextPaginator {
  private builder = new TextStreamBuilder()
  private used = 0
  private pages = 0

  constructor(private readonly onPage: (page: NormalizedPage) => void) {}

  get pageCount(): number {
    return this.pages
  }

  line(line: TextLine): void {
    if (this.used > 0 && this.used + line.text.length > CHARS_PER_PAGE) {
      this.flush()
    }

    // A blank line contributes no span — there is nothing there to redact —
    // but it still occupies its newline in the page's text stream.
    if (line.text.length > 0) {
      this.builder.append(textAddress(line.start), line.text)
    }
    this.builder.pad("\n")
    this.used += line.text.length + 1
  }

  end(): void {
    if (this.builder.text.length > 0 || this.pages === 0) this.flush()
  }

  private flush(): void {
    this.pages += 1
    this.onPage({
      number: this.pages,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      text: this.builder.text,
      spans: this.builder.spans,
    })
    this.builder = new TextStreamBuilder()
    this.used = 0
  }
}

export function paginateText(text: string): NormalizedPage[] {
  const pages: NormalizedPage[] = []
  const paginator = new TextPaginator((page) => pages.push(page))
  for (const line of linesOf(text)) paginator.line(line)
  paginator.end()
  return pages
}

export type TextExtraction = {
  document: NormalizedDocument
  /** The decoded source, so callers do not decode it twice. */
  text: string
}

function tooManyCharacters(): Error {
  return new Error(
    `File holds more than ${MAX_TEXT_CHARS} characters, which is beyond what can be reviewed`
  )
}

export function extractText(
  documentId: string,
  bytes: Uint8Array
): TextExtraction {
  const { text, bom } = decodeText(bytes)

  if (text.length > MAX_TEXT_CHARS) throw tooManyCharacters()

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

/**
 * Plain text extraction that never holds the file.
 *
 * Bytes go in a piece at a time and JSON comes out a page at a time: the
 * normalized model is written as it is produced rather than built and then
 * serialized, and what `end` finishes is exactly what
 * `JSON.stringify(extractText(...).document)` would have been. So the memory
 * this costs is a piece of the file and a page of the model, whatever the
 * file's size — and `MAX_TEXT_CHARS` is a statement about what a reviewer can
 * be asked to read rather than about what fits in memory.
 *
 * A file that is refused is refused for the reason the whole-file extraction
 * would have given, found in the same order — which means some refusals are
 * only known at the end, after pages have already been written. The caller
 * discards what was written when `end` throws.
 */
export class TextExtractionStream {
  private readonly decoder = new TextDecodingStream()
  private readonly paginator: TextPaginator
  private readonly lines: LineSplitter
  private out: string[] = []
  private characters = 0
  private lineCount = 0
  private written = 0

  constructor(documentId: string) {
    this.paginator = new TextPaginator((page) => {
      this.out.push(this.written === 0 ? "" : ",", JSON.stringify(page))
      this.written += 1
    })
    this.lines = new LineSplitter((line) => {
      this.lineCount += 1
      this.paginator.line(line)
    })
    this.out.push(
      `{"documentId":${JSON.stringify(documentId)},"kind":"txt","pages":[`
    )
  }

  get pageCount(): number {
    return this.paginator.pageCount
  }

  /** Takes the next piece of the file; returns the JSON it completed. */
  write(bytes: Uint8Array): string {
    this.accept(this.decoder.write(bytes))
    return this.take()
  }

  /** Finishes the file; returns the rest of the JSON, or throws its refusal. */
  end(): string {
    this.accept(this.decoder.end())
    if (this.characters > MAX_TEXT_CHARS) throw tooManyCharacters()

    this.lines.end()
    this.paginator.end()
    this.out.push(
      `],"metadata":${JSON.stringify({
        characters: this.characters,
        lines: this.lineCount,
        byteOrderMark: this.decoder.bom,
        pageCount: this.paginator.pageCount,
      })}}`
    )
    return this.take()
  }

  private accept(text: string): void {
    this.characters += text.length
    // Past either refusal nothing produced from here is kept, so nothing is
    // produced; the decoder keeps going only to find a refusal that outranks
    // the one already known.
    if (this.decoder.refused || this.characters > MAX_TEXT_CHARS) return
    this.lines.write(text)
  }

  private take(): string {
    const json = this.out.join("")
    this.out = []
    return json
  }
}
