import type {
  SourceAtom,
  SourceAtomKind,
} from "@/lib/documents/shared/atoms"

/**
 * RTF, parsed into visible text plus the map back to where it came from.
 *
 * Nothing about RTF lets you search it for a name. A word processor is free to
 * split "john@example.com" into `john@exa`, a formatting group, and
 * `mple.com`; to write the `é` in a name as `\'e9` or `\u233?`; to put a
 * `\par` in the middle of an address. A regular expression over the source
 * finds none of those, and a replacement made against the source is as likely
 * to delete half a control word as a character — which produces a file that no
 * longer opens.
 *
 * So the source is tokenized once into *atoms*: pieces of RTF that each
 * contribute a known slice of visible text. The decoded text is what the
 * detectors, the reviewer and the exporter all work in, and every offset in it
 * translates back to an exact byte range in the original. Redaction then
 * removes those byte ranges — never a brace, never a control word — so what
 * comes out is still RTF.
 *
 * The parse is deterministic, so the exporter re-running it gets the identical
 * atoms and an offset captured at extraction still names the same characters.
 * That is the same contract the DOCX pipeline relies on, reached differently.
 */

/**
 * The three atom kinds are shared with the HTML parser inside the email
 * pipeline, because it is the same problem: see lib/documents/shared/atoms.ts.
 * Here a `\par` is structural, `\'e9` and `\u233?` are escapes, and ordinary
 * characters are literals whose bytes are their characters.
 */
export type RtfAtomKind = SourceAtomKind

export type RtfAtom = SourceAtom

export type RtfDocument = {
  /** Visible text, in document order. */
  text: string
  atoms: RtfAtom[]
}

export class RtfParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RtfParseError"
  }
}

/**
 * Groups whose contents are never visible text: font and colour tables, style
 * definitions, revision tables, embedded pictures and objects. Their contents
 * are full of strings that look like text and are not, so walking into them
 * would offer the reviewer a font name to redact.
 */
const IGNORED_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "listtable",
  "listoverridetable",
  "revtbl",
  "rsidtbl",
  "generator",
  "info",
  "pict",
  "object",
  "themedata",
  "colorschememapping",
  "datastore",
  "latentstyles",
  "xmlnstbl",
  "mmathPr",
  "filetbl",
  "upr",
])

/** Control words that produce visible text of their own. */
const TEXT_CONTROLS: Record<string, string> = {
  par: "\n",
  line: "\n",
  sect: "\n",
  page: "\n",
  row: "\n",
  cell: "\t",
  tab: "\t",
  nestcell: "\t",
  nestrow: "\n",
  emdash: "\u2014",
  endash: "\u2013",
  emspace: " ",
  enspace: " ",
  qmspace: " ",
  bullet: "\u2022",
  lquote: "\u2018",
  rquote: "\u2019",
  ldblquote: "\u201c",
  rdblquote: "\u201d",
  ltrmark: "",
  rtlmark: "",
  zwj: "",
  zwnj: "",
}

/** Control symbols that stand for one literal character. */
const SYMBOL_CHARACTERS: Record<string, string> = {
  "\\": "\\",
  "{": "{",
  "}": "}",
  "~": "\u00a0",
  "-": "",
  _: "-",
  "\n": "\n",
  "\r": "",
}

/**
 * Windows-1252's upper range, which is where `\'hh` escapes differ from
 * Latin-1. A curly apostrophe in a name arrives as `\'92`, and reading it as
 * Latin-1 would give a control character instead.
 */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018,
  0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161,
  0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
]

function characterFromByte(byte: number): string {
  if (byte >= 0x80 && byte <= 0x9f) {
    return String.fromCharCode(CP1252_HIGH[byte - 0x80])
  }
  return String.fromCharCode(byte)
}

/** Limits, so a hostile file cannot make the parser the expensive part. */
export const MAX_RTF_GROUP_DEPTH = 128

/**
 * Decodes RTF bytes as Latin-1.
 *
 * RTF is a 7-bit format with escapes for everything else, but real files carry
 * stray high bytes inside binary destinations. Latin-1 maps every byte to
 * exactly one character, so a source offset is a byte offset, and encoding the
 * result back is lossless — which is what makes byte-level surgery safe.
 */
export function decodeRtf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1")
}

export function encodeRtf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"))
}

export function looksLikeRtf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 8)).toString("latin1")
  return head.startsWith("{\\rtf")
}

type Frame = {
  /** How many fallback characters a `\uN` escape is followed by. */
  unicodeSkip: number
  /** True while inside a destination whose text is not document text. */
  ignoring: boolean
}

export function parseRtf(source: string): RtfDocument {
  if (!source.startsWith("{\\rtf")) {
    throw new RtfParseError("File does not begin with an RTF header")
  }

  const atoms: RtfAtom[] = []
  let text = ""

  const stack: Frame[] = [{ unicodeSkip: 1, ignoring: false }]
  let frame = stack[0]

  /** Fallback characters still to be swallowed after a `\uN`. */
  let skipChars = 0

  const emit = (kind: RtfAtomKind, start: number, end: number, value: string) => {
    if (frame.ignoring || value.length === 0) return
    atoms.push({
      kind,
      start,
      end,
      textStart: text.length,
      textEnd: text.length + value.length,
    })
    text += value
  }

  let index = 0
  const length = source.length

  while (index < length) {
    const character = source[index]

    if (character === "{") {
      if (stack.length >= MAX_RTF_GROUP_DEPTH) {
        throw new RtfParseError("RTF groups are nested too deeply")
      }
      stack.push({ ...frame })
      frame = stack[stack.length - 1]
      index += 1
      skipChars = 0
      continue
    }

    if (character === "}") {
      if (stack.length > 1) {
        stack.pop()
        frame = stack[stack.length - 1]
      }
      index += 1
      skipChars = 0
      continue
    }

    if (character === "\\") {
      const next = source[index + 1]

      if (next === undefined) break

      // `\*\destination` — an extension whose whole group is optional, and
      // which by definition is not document text.
      if (next === "*") {
        frame.ignoring = true
        index += 2
        continue
      }

      if (!/[a-zA-Z]/.test(next)) {
        // A control symbol: one character, possibly a hex escape.
        if (next === "'") {
          const hex = source.slice(index + 2, index + 4)
          const byte = parseInt(hex, 16)
          const end = index + 4
          if (Number.isFinite(byte)) {
            if (skipChars > 0) skipChars -= 1
            else emit("escape", index, end, characterFromByte(byte))
          }
          index = end
          continue
        }

        const value = SYMBOL_CHARACTERS[next]
        if (value !== undefined) {
          emit(next === "\n" ? "structural" : "escape", index, index + 2, value)
        }
        index += 2
        continue
      }

      // A control word: letters, an optional signed number, one optional space.
      const match = /^([a-zA-Z]+)(-?\d+)? ?/.exec(source.slice(index + 1))
      if (!match) {
        index += 1
        continue
      }

      const word = match[1]
      const parameter = match[2] === undefined ? null : Number(match[2])
      const end = index + 1 + match[0].length

      if (word === "bin" && parameter !== null && parameter > 0) {
        // Raw bytes follow, and they can contain anything including braces.
        index = Math.min(length, end + parameter)
        continue
      }

      if (word === "uc") {
        frame.unicodeSkip = Math.max(0, parameter ?? 1)
        index = end
        continue
      }

      if (word === "u" && parameter !== null) {
        // RTF writes the code unit as a signed 16-bit value.
        const code = parameter < 0 ? parameter + 65536 : parameter
        emit("escape", index, end, String.fromCharCode(code))
        skipChars = frame.unicodeSkip
        index = end
        continue
      }

      if (IGNORED_DESTINATIONS.has(word)) {
        frame.ignoring = true
        index = end
        continue
      }

      const produced = TEXT_CONTROLS[word]
      if (produced !== undefined) {
        emit("structural", index, end, produced)
      }

      index = end
      continue
    }

    if (character === "\r" || character === "\n") {
      // Line breaks in the source are formatting of the RTF itself, not of the
      // document, and carry no text.
      index += 1
      continue
    }

    // A run of plain characters. Taken as one atom because source bytes and
    // text characters correspond exactly here, so a partial cut can be sliced.
    let end = index
    while (
      end < length &&
      !"\\{}\r\n".includes(source[end])
    ) {
      end += 1
    }

    const value = source.slice(index, end)

    // Fallback characters after a `\uN` are the same character written for an
    // older reader, and emitting them would duplicate it.
    if (skipChars > 0) {
      const swallowed = Math.min(skipChars, value.length)
      skipChars -= swallowed
      emit("literal", index + swallowed, end, value.slice(swallowed))
      index = end
      continue
    }

    emit("literal", index, end, value)
    index = end
  }

  return { text, atoms }
}
