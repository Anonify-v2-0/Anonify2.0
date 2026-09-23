/**
 * Delimited text, parsed rather than split.
 *
 * `line.split(",")` is wrong for most real CSV and wrong in the direction that
 * matters here: a quoted field holding a comma, a quote escaped by doubling
 * it, or a newline inside a quoted value all shift every subsequent field by
 * one. A redaction addressed to row 4 column 2 would then land somewhere else
 * in the file, which is a leak wearing the shape of a bug.
 *
 * So this is a state machine over the characters, and it keeps enough about
 * how each field was written — whether it was quoted — that serializing the
 * grid back produces a file that reads like the one that arrived.
 *
 * CSV and TSV differ only in the delimiter. They are not two parsers.
 */

export type Delimiter = "," | "\t"

export type DelimitedField = {
  value: string
  /** True when the source wrote this field inside quotes. */
  quoted: boolean
}

export type DelimitedDocument = {
  rows: DelimitedField[][]
  delimiter: Delimiter
  /** The line ending the file used, reproduced on the way out. */
  eol: "\r\n" | "\n"
  /** True when the file began with a UTF-8 byte-order mark. */
  bom: boolean
  /** True when the last row ended with a line break. */
  trailingNewline: boolean
}

export const UTF8_BOM = "﻿"

/**
 * Control characters that mean this is not a text file, whatever its name
 * says. Tab, carriage return and newline are deliberately not among them.
 */
const DISALLOWED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/

export class DelimitedParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DelimitedParseError"
  }
}

const INVALID_UTF8 = "File is not valid UTF-8 text"
const CONTROL_BYTES = "File contains control bytes, so it is not text"

/**
 * Decodes UTF-8 as it arrives, refusing anything that is not text.
 *
 * A `fatal` decoder is the point: silently turning invalid sequences into
 * replacement characters would mean exporting a file whose bytes differ from
 * the ones we were given in places nobody asked us to touch.
 *
 * The refusals come out in the order the whole-file decode gave them, because
 * the order is what the reviewer is told. Invalid UTF-8 anywhere is reported
 * over a control byte anywhere, so an invalid sequence throws the moment it
 * is met, and a control byte is only noted — `refused` turns true, so callers
 * can stop doing work nobody will keep — and reported at the end, once the
 * rest of the file has been shown to decode.
 */
export class TextDecodingStream {
  // `ignoreBOM` keeps the mark as a character instead of having the decoder
  // silently eat it: we strip it ourselves, and we have to know it was there
  // to write it back on the way out.
  private readonly decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  })
  private started = false
  private control = false
  /** True when the file began with a UTF-8 byte-order mark. */
  bom = false

  /** True once the file is known to be refused whatever follows. */
  get refused(): boolean {
    return this.control
  }

  write(bytes: Uint8Array): string {
    let text: string
    try {
      // `stream` holds back a sequence split across two pieces rather than
      // calling it invalid.
      text = this.decoder.decode(bytes, { stream: true })
    } catch {
      throw new DelimitedParseError(INVALID_UTF8)
    }
    return this.accept(text)
  }

  end(): string {
    let text: string
    try {
      text = this.decoder.decode()
    } catch {
      throw new DelimitedParseError(INVALID_UTF8)
    }
    const rest = this.accept(text)
    if (this.control) throw new DelimitedParseError(CONTROL_BYTES)
    return rest
  }

  private accept(text: string): string {
    if (!this.started && text.length > 0) {
      this.started = true
      if (text.startsWith(UTF8_BOM)) {
        this.bom = true
        text = text.slice(UTF8_BOM.length)
      }
    }
    if (!this.control && DISALLOWED.test(text)) this.control = true
    return text
  }
}

/** Decodes a whole file; see `TextDecodingStream`. */
export function decodeText(bytes: Uint8Array): { text: string; bom: boolean } {
  const decoder = new TextDecodingStream()
  const text = decoder.write(bytes) + decoder.end()
  return { text, bom: decoder.bom }
}

/**
 * Parses delimited text as it arrives, one row at a time.
 *
 * Rules are RFC 4180's, with the leniencies real files need: a bare quote
 * inside an unquoted field is data, a quoted field may contain newlines, and a
 * doubled quote inside a quoted field is one quote.
 *
 * Two characters cannot be decided alone — a quote inside quotes might be the
 * first of a doubled pair, and a CR might be the first half of a CRLF — so
 * when one of them ends a piece it is held back until the next piece says
 * which it was. That is the only state carried between pieces besides the
 * field in progress, and it is why a row reaches `onRow` exactly as the
 * whole-string parse would have produced it.
 */
export class DelimitedParser {
  private row: DelimitedField[] = []
  private field = ""
  private quoted = false
  private inQuotes = false
  private held = ""
  private sawAnyCharacter = false
  private last = ""
  private eol: "\r\n" | "\n" | null = null

  constructor(
    readonly delimiter: Delimiter,
    private readonly onRow: (row: DelimitedField[]) => void
  ) {}

  write(text: string): void {
    if (text.length === 0) return

    // The file's line ending is whichever style its first newline uses —
    // decided over the raw text, quoted or not, exactly as before.
    if (this.eol === null) {
      const newline = text.indexOf("\n")
      if (newline !== -1) {
        const before = newline > 0 ? text[newline - 1] : this.last
        this.eol = before === "\r" ? "\r\n" : "\n"
      }
    }

    this.sawAnyCharacter = true
    this.last = text[text.length - 1]
    this.consume(this.held + text, false)
  }

  /** Finishes the parse. Throws for a quoted field that never closed. */
  end(): { eol: "\r\n" | "\n"; trailingNewline: boolean } {
    const held = this.held
    this.held = ""
    this.consume(held, true)

    if (this.inQuotes) {
      // An unterminated quote means every field after it is in the wrong place.
      // Guessing would put a redaction on the wrong cell.
      throw new DelimitedParseError("A quoted field was never closed")
    }

    // A file ending in a line break has already had its last row closed by that
    // break; one that does not has a row still open.
    const trailingNewline =
      this.sawAnyCharacter && (this.last === "\r" || this.last === "\n")
    if (this.sawAnyCharacter && !trailingNewline) this.endRow()

    return { eol: this.eol ?? "\n", trailingNewline }
  }

  private endField(): void {
    this.row.push({ value: this.field, quoted: this.quoted })
    this.field = ""
    this.quoted = false
  }

  private endRow(): void {
    this.endField()
    const row = this.row
    this.row = []
    this.onRow(row)
  }

  private consume(text: string, final: boolean): void {
    const { delimiter } = this
    let index = 0

    while (index < text.length) {
      const character = text[index]
      const hasNext = index + 1 < text.length

      if (this.inQuotes) {
        if (character === '"') {
          if (!hasNext && !final) break
          if (text[index + 1] === '"') {
            this.field += '"'
            index += 2
            continue
          }
          this.inQuotes = false
          index += 1
          continue
        }
        this.field += character
        index += 1
        continue
      }

      if (character === '"' && this.field.length === 0) {
        this.inQuotes = true
        this.quoted = true
        index += 1
        continue
      }

      if (character === delimiter) {
        this.endField()
        index += 1
        continue
      }

      if (character === "\r") {
        if (!hasNext && !final) break
        this.endRow()
        index += text[index + 1] === "\n" ? 2 : 1
        continue
      }

      if (character === "\n") {
        this.endRow()
        index += 1
        continue
      }

      this.field += character
      index += 1
    }

    this.held = text.slice(index)
  }
}

/** Parses a whole delimited file held in memory; see `DelimitedParser`. */
export function parseDelimited(
  text: string,
  delimiter: Delimiter,
  options: { bom?: boolean } = {}
): DelimitedDocument {
  const rows: DelimitedField[][] = []
  const parser = new DelimitedParser(delimiter, (row) => rows.push(row))
  parser.write(text)
  const { eol, trailingNewline } = parser.end()

  return {
    rows,
    delimiter,
    eol,
    bom: options.bom ?? false,
    trailingNewline,
  }
}

/**
 * Whether a value has to be quoted to survive a round trip. A field is quoted
 * if it was quoted in the source and still can be, or if it now contains
 * something that would otherwise change the shape of the grid.
 */
function mustQuote(value: string, delimiter: Delimiter): boolean {
  return (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  )
}

export function serializeField(
  field: DelimitedField,
  delimiter: Delimiter
): string {
  const quote = field.quoted || mustQuote(field.value, delimiter)
  if (!quote) return field.value
  return `"${field.value.replace(/"/g, '""')}"`
}

export function serializeDelimited(document: DelimitedDocument): string {
  const body = document.rows
    .map((row) =>
      row.map((field) => serializeField(field, document.delimiter)).join(
        document.delimiter
      )
    )
    .join(document.eol)

  const text = document.trailingNewline ? `${body}${document.eol}` : body
  return document.bom ? `${UTF8_BOM}${text}` : text
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
