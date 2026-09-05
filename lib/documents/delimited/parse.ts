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

/**
 * Decodes bytes as UTF-8 and refuses anything that is not text.
 *
 * A `fatal` decoder is the point: silently turning invalid sequences into
 * replacement characters would mean exporting a file whose bytes differ from
 * the ones we were given in places nobody asked us to touch.
 */
export function decodeText(bytes: Uint8Array): { text: string; bom: boolean } {
  let text: string
  try {
    // `ignoreBOM` keeps the mark as a character instead of having the decoder
    // silently eat it: we strip it ourselves, and we have to know it was there
    // to write it back on the way out.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    )
  } catch {
    throw new DelimitedParseError("File is not valid UTF-8 text")
  }

  const bom = text.startsWith(UTF8_BOM)
  if (bom) text = text.slice(UTF8_BOM.length)

  if (DISALLOWED.test(text)) {
    throw new DelimitedParseError("File contains control bytes, so it is not text")
  }

  return { text, bom }
}

function detectEol(text: string): "\r\n" | "\n" {
  const carriage = text.indexOf("\r\n")
  if (carriage === -1) return "\n"
  const bare = text.indexOf("\n")
  // Whichever style appears first is the file's own.
  return carriage <= bare ? "\r\n" : "\n"
}

/**
 * Parses delimited text.
 *
 * Rules are RFC 4180's, with the leniencies real files need: a bare quote
 * inside an unquoted field is data, a quoted field may contain newlines, and a
 * doubled quote inside a quoted field is one quote.
 */
export function parseDelimited(
  text: string,
  delimiter: Delimiter,
  options: { bom?: boolean } = {}
): DelimitedDocument {
  const eol = detectEol(text)
  const rows: DelimitedField[][] = []

  let row: DelimitedField[] = []
  let field = ""
  let quoted = false
  let inQuotes = false
  let index = 0
  let sawAnyCharacter = false

  const endField = () => {
    row.push({ value: field, quoted })
    field = ""
    quoted = false
  }

  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (index < text.length) {
    const character = text[index]
    sawAnyCharacter = true

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += character
      index += 1
      continue
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true
      quoted = true
      index += 1
      continue
    }

    if (character === delimiter) {
      endField()
      index += 1
      continue
    }

    if (character === "\r" && text[index + 1] === "\n") {
      endRow()
      index += 2
      continue
    }

    if (character === "\n" || character === "\r") {
      endRow()
      index += 1
      continue
    }

    field += character
    index += 1
  }

  if (inQuotes) {
    // An unterminated quote means every field after it is in the wrong place.
    // Guessing would put a redaction on the wrong cell.
    throw new DelimitedParseError("A quoted field was never closed")
  }

  // A file ending in a line break has already had its last row closed by that
  // break; one that does not has a row still open.
  const trailingNewline = sawAnyCharacter && /[\r\n]$/.test(text)
  if (sawAnyCharacter && !trailingNewline) endRow()

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
