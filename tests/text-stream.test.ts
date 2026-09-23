import { describe, expect, it } from "vitest"

import {
  DelimitedExtractionStream,
  extractDelimited,
  MAX_ROWS,
} from "@/lib/documents/delimited/extract"
import {
  DelimitedParseError,
  DelimitedParser,
  parseDelimited,
  UTF8_BOM,
  type DelimitedField,
} from "@/lib/documents/delimited/parse"
import {
  extractText,
  LineSplitter,
  linesOf,
  MAX_TEXT_CHARS,
  TextExtractionStream,
  type TextLine,
} from "@/lib/documents/text/extract"

/**
 * Text and delimited extraction, streamed, held to the whole-file extraction.
 *
 * The streaming extractors read a file in whatever pieces storage hands over
 * and write the normalized model as they go. The contract is that what they
 * write is exactly — to the character — what the whole-file extractor would
 * have serialized, for every way the file can be cut: a CRLF split across two
 * pieces, a quote pair split, a four-byte character split three ways. And a
 * file that is refused is refused for the same reason, found in the same
 * order, because that reason is the sentence the reviewer is shown.
 */

function cutsOf(bytes: Uint8Array, size: number): Uint8Array[] {
  const pieces: Uint8Array[] = []
  for (let at = 0; at < bytes.byteLength; at += size) {
    pieces.push(bytes.subarray(at, at + size))
  }
  return pieces
}

type Extractor = { write(bytes: Uint8Array): string; end(): string }

function streamed(extractor: Extractor, pieces: Uint8Array[]): string {
  let json = ""
  for (const piece of pieces) json += extractor.write(piece)
  return json + extractor.end()
}

/** What the extractor threw, or its output. */
function outcome(run: () => string): string {
  try {
    return run()
  } catch (error) {
    return `threw: ${(error as Error).message}`
  }
}

const SIZES = [1, 2, 3, 5, 7, 64, 4096]

const TEXTS = [
  "",
  "one line",
  "ends with a newline\n",
  "crlf\r\nlines\r\nhere\r\n",
  "lone\rcarriage\rreturns\r",
  "mixed\r\n\n\r\rendings",
  `${UTF8_BOM}a byte-order mark first\n`,
  "multi-byte: café, 名前, 🙂 and 𝄞\n".repeat(3),
  `${"a long line without breaks ".repeat(300)}\nshort\n`,
  Array.from(
    { length: 400 },
    (_, index) => `Line ${index}: John Smith, 555-0100`
  ).join("\n"),
]

describe("streamed plain text extraction", () => {
  it("writes exactly the model the whole-file extraction serializes", () => {
    for (const text of TEXTS) {
      const bytes = new TextEncoder().encode(text)
      const whole = JSON.stringify(extractText("doc_t", bytes).document)
      for (const size of SIZES) {
        expect(
          streamed(new TextExtractionStream("doc_t"), cutsOf(bytes, size))
        ).toBe(whole)
      }
    }
  })

  it("counts the pages it wrote", () => {
    const bytes = new TextEncoder().encode(TEXTS[TEXTS.length - 1])
    const extractor = new TextExtractionStream("doc_t")
    streamed(extractor, cutsOf(bytes, 100))
    expect(extractor.pageCount).toBe(
      extractText("doc_t", bytes).document.pages.length
    )
  })

  it("splits lines exactly as the whole-string splitter does", () => {
    for (const text of TEXTS) {
      const lines: TextLine[] = []
      const splitter = new LineSplitter((line) => lines.push(line))
      for (let at = 0; at < text.length; at += 3)
        splitter.write(text.slice(at, at + 3))
      splitter.end()
      expect(lines).toEqual(linesOf(text))
    }
  })

  it("refuses what the whole-file extraction refuses, for the same reason", () => {
    const cases = [
      new Uint8Array([0x61, 0xff, 0x62]),
      new TextEncoder().encode("text with a \u0001 control byte"),
      // Both: invalid UTF-8 outranks a control byte, wherever each one is.
      new Uint8Array([...new TextEncoder().encode("\u0001 first"), 0xc3, 0x28]),
      // Truncated in the middle of a character.
      new Uint8Array([0x61, 0xe2, 0x82]),
    ]
    for (const bytes of cases) {
      const whole = outcome(() =>
        JSON.stringify(extractText("doc_t", bytes).document)
      )
      expect(whole).toMatch(/^threw: /)
      for (const size of [1, 2, 64]) {
        expect(
          outcome(() =>
            streamed(new TextExtractionStream("doc_t"), cutsOf(bytes, size))
          )
        ).toBe(whole)
      }
    }
  })

  it("refuses a file past the character limit, after checking it is text", () => {
    // Not built: the limit is millions of characters. The order is what is
    // under test, so a stream that says it saw too many is enough.
    const extractor = new TextExtractionStream("doc_t")
    const piece = new TextEncoder().encode("x".repeat(1_000_000))
    let written = 0
    expect(() => {
      while (written <= MAX_TEXT_CHARS) {
        extractor.write(piece)
        written += piece.byteLength
      }
      extractor.end()
    }).toThrow(/more than/)

    const bad = new TextExtractionStream("doc_t")
    let seen = 0
    while (seen <= MAX_TEXT_CHARS) {
      bad.write(piece)
      seen += piece.byteLength
    }
    bad.write(new Uint8Array([0x01]))
    // A control byte outranks the size, exactly as decoding came first before.
    expect(() => bad.end()).toThrow(DelimitedParseError)
  }, 30_000)
})

const GRIDS = [
  "",
  "name,email\nJohn,john@example.com\n",
  "name,email\r\nJohn,john@example.com\r\nJane,jane@example.com",
  'a,"quoted, with comma","doubled ""quote"""\r\n"multi\r\nline",x,\n',
  '"ends in quote"',
  "tail,cr\r",
  `${UTF8_BOM}bom,first\n1,2\n`,
  "ragged\n1,2,3,4\n,,\n5\n",
  "header only,,third\n",
  `${Array.from({ length: 300 }, (_, row) => `${row},Person ${row},"${row}@example.com"`).join("\n")}\n`,
  "名前,メール\n山田,yamada@example.jp\n",
]

describe("streamed delimited extraction", () => {
  it("writes exactly the model the whole-file extraction serializes", () => {
    for (const kind of ["csv", "tsv"] as const) {
      for (const text of GRIDS) {
        const source = kind === "tsv" ? text.replace(/,/g, "\t") : text
        const bytes = new TextEncoder().encode(source)
        const whole = outcome(() =>
          JSON.stringify(extractDelimited("doc_c", kind, bytes).document)
        )
        for (const size of SIZES) {
          expect(
            outcome(() =>
              streamed(
                new DelimitedExtractionStream("doc_c", kind),
                cutsOf(bytes, size)
              )
            )
          ).toBe(whole)
        }
      }
    }
  })

  it("counts the cells it wrote", () => {
    const bytes = new TextEncoder().encode(GRIDS[GRIDS.length - 2])
    const extractor = new DelimitedExtractionStream("doc_c", "csv")
    streamed(extractor, cutsOf(bytes, 17))
    expect(extractor.cells).toBe(
      extractDelimited("doc_c", "csv", bytes).document.sheets?.[0].cells.length
    )
  })

  it("parses rows exactly as the whole-string parser does, however it is cut", () => {
    for (const text of GRIDS) {
      const whole = parseDelimited(text, ",")
      for (const size of [1, 2, 3]) {
        const rows: DelimitedField[][] = []
        const parser = new DelimitedParser(",", (row) => rows.push(row))
        for (let at = 0; at < text.length; at += size)
          parser.write(text.slice(at, at + size))
        const { eol, trailingNewline } = parser.end()
        expect({ rows, eol, trailingNewline }).toEqual({
          rows: whole.rows,
          eol: whole.eol,
          trailingNewline: whole.trailingNewline,
        })
      }
    }
  })

  it("refuses what the whole-file extraction refuses, for the same reason", () => {
    const cases = [
      '"never closed,1\n2,3\n',
      "a,b\n\u0001,c\n",
      // An unclosed quote and a control byte: the control byte is reported.
      '"open,\u0001\n',
    ].map((text) => new TextEncoder().encode(text))
    cases.push(new Uint8Array([0x61, 0x2c, 0xfe]))

    for (const bytes of cases) {
      const whole = outcome(() =>
        JSON.stringify(extractDelimited("doc_c", "csv", bytes).document)
      )
      expect(whole).toMatch(/^threw: /)
      for (const size of [1, 3, 64]) {
        expect(
          outcome(() =>
            streamed(
              new DelimitedExtractionStream("doc_c", "csv"),
              cutsOf(bytes, size)
            )
          )
        ).toBe(whole)
      }
    }
  })

  it("refuses too many rows only after the grid has parsed", () => {
    const rows = `${"1,2\n".repeat(MAX_ROWS + 1)}`
    const bytes = new TextEncoder().encode(rows)
    expect(() =>
      streamed(
        new DelimitedExtractionStream("doc_c", "csv"),
        cutsOf(bytes, 65536)
      )
    ).toThrow(/more than/)

    const unclosed = new TextEncoder().encode(`${rows}"open`)
    expect(() =>
      streamed(
        new DelimitedExtractionStream("doc_c", "csv"),
        cutsOf(unclosed, 65536)
      )
    ).toThrow(/never closed/)
  })
})
