import type { SourceAtom } from "@/lib/documents/shared/atoms"

/**
 * The visible text of an HTML body, as markdown, and the map back to it.
 *
 * An HTML email is the same problem RTF poses, in different clothing. The
 * value a reader sees can be split by a `<span>`, written with entities
 * (`john&#64;example.com`), or sitting in an `href="mailto:…"` that never
 * appears on screen at all. Searching the markup finds none of the first two;
 * replacing in the markup can destroy a tag or leave half an entity behind,
 * and half an entity corrupts every character after it.
 *
 * So the same treatment: parse once into atoms that each contribute a known
 * slice of visible text and remember the bytes they came from. Text nodes
 * become literals, entities become escapes, and everything the markup was
 * *saying* — this is a heading, this is a list item, this row has three cells
 * — becomes structure.
 *
 * ## Why markdown
 *
 * Structural atoms used to contribute a bare `\n`, which flattened a message
 * into a wall of text: a reviewer could not tell a table from a paragraph, or
 * the quoted reply from the reply. They now contribute markdown instead —
 * `## ` for a heading, `- ` for a list item, `> ` for a quote, `| a | b |` for
 * a row.
 *
 * This costs nothing at export. A structural atom is never removed and never
 * carries source characters, so the markdown is a *review* representation
 * only: the exporter still cuts byte ranges out of the original markup, and a
 * part nobody edited still comes out identical to the byte. What changes is
 * that the offsets a reviewer works in now index a string that reads like the
 * message instead of like its debris.
 *
 * Nobody reviewing an email needs its colours, its fonts or its tracking
 * pixels. They need to know who is in the table and where the quoted thread
 * starts. That is what markdown carries and styling does not.
 *
 * ## Whitespace
 *
 * Markup indentation is not text. `<td>\n    Alice\n  </td>` is one word, and
 * emitting the newlines and spaces around it as literals put them in front of
 * the reviewer and broke every block boundary this file works to establish.
 * Runs of whitespace between markup therefore collapse to a single structural
 * space, or to nothing at a line boundary — except inside `<pre>`, where the
 * whitespace is the content.
 *
 * ## Links and images
 *
 * A link becomes `[text](url)` and an image becomes `![alt]`, with the URL and
 * the alt text emitted as *literal* atoms over their own bytes. That makes
 * them reviewable: an address that appears only inside `href="mailto:…"` used
 * to be swept at export and never shown, so the reviewer was trusting a
 * removal they could not see. Now they can point at it.
 *
 * Attribute values are still collected separately as well, because the sweep
 * has to reach `src`, `title` and the attributes of tags that contribute no
 * text of their own.
 *
 * Script and style contents are skipped entirely. They are not visible text,
 * they are full of strings that look like text, and offering a reviewer a CSS
 * selector to redact would be noise at best.
 */

export type HtmlText = {
  /** Visible text as markdown, in document order. */
  text: string
  /** Atoms over `text`, for review and for addressed redaction. */
  atoms: SourceAtom[]
  /**
   * Atoms over attribute values, keyed by the value's own text. Used only by
   * the sweep, which searches for whole accepted values.
   */
  attributes: { value: string; start: number; end: number }[]
}

/** Tags whose content is not text a reader sees. */
const OPAQUE = new Set(["script", "style", "head", "title"])

/** Tags that open and close a block, so a blank line goes on either side. */
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "aside",
  "nav",
  "main",
  "header",
  "footer",
  "figure",
  "figcaption",
  "center",
  "form",
  "fieldset",
  "address",
  "dl",
])

/** Tags that end a line without opening a block of their own. */
const LINE = new Set(["br", "dt", "dd", "caption", "legend"])

/** Attributes that can carry a copy of a value shown elsewhere. */
const TEXT_ATTRIBUTES = new Set(["href", "src", "alt", "title", "value"])

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
}

export function decodeEntity(entity: string): string | null {
  const named = /^&([a-zA-Z][a-zA-Z0-9]*);$/.exec(entity)
  if (named) {
    const value = NAMED_ENTITIES[named[1].toLowerCase()]
    return value ?? null
  }

  const numeric = /^&#(x?)([0-9a-fA-F]+);$/.exec(entity)
  if (!numeric) return null

  const code = parseInt(numeric[2], numeric[1] ? 16 : 10)
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null
  try {
    return String.fromCodePoint(code)
  } catch {
    return null
  }
}

export function encodeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** An attribute's value and the bytes it occupies, quotes excluded. */
type Attribute = { value: string; start: number; end: number }

type ListFrame = { ordered: boolean; index: number }

/** A table being written, and whether the current row is using pipes. */
type TableFrame = { rows: number; cells: number; piped: boolean }

/**
 * Writes markdown while keeping every source character addressable.
 *
 * The whole class is one rule: anything that came from the message goes in as
 * a `literal` or an `escape` atom carrying its own byte range, and everything
 * this code decided to write — a `## `, a `|`, a newline — goes in as
 * `structural`, which `sourceCutsFor` skips and no redaction can ever remove.
 *
 * Line openings are therefore deferred. The prefix a line needs is not known
 * until something is actually written on it, and a paragraph that turns out to
 * be empty must not leave a stray `- ` behind.
 */
class MarkdownWriter {
  text = ""
  readonly atoms: SourceAtom[] = []

  private lists: ListFrame[] = []
  private tables: TableFrame[] = []
  private quote = 0
  private pre = 0
  private bold = 0
  private italic = 0
  private code = 0

  /** 0 none, 1 a line break, 2 a blank line. */
  private pendingBreak = 0
  private pendingSpace = false
  private pendingMarker: string | null = null
  private lineOpen = false

  private push(
    kind: SourceAtom["kind"],
    start: number,
    end: number,
    value: string
  ): void {
    if (value.length === 0) return
    this.atoms.push({
      kind,
      start,
      end,
      textStart: this.text.length,
      textEnd: this.text.length + value.length,
    })
    this.text += value
  }

  private trailingNewlines(): number {
    let count = 0
    while (count < 2 && this.text[this.text.length - 1 - count] === "\n") {
      count += 1
    }
    return count
  }

  /** The quote markers, indent and list marker this line starts with. */
  private linePrefix(): string {
    if (this.pre > 0) return ""

    let prefix = "> ".repeat(this.quote)

    if (this.pendingMarker !== null) {
      prefix +=
        "  ".repeat(Math.max(0, this.lists.length - 1)) + this.pendingMarker
      this.pendingMarker = null
    } else if (this.lists.length > 0) {
      prefix += "  ".repeat(this.lists.length)
    }

    return prefix
  }

  /** Opens the current line, writing the breaks and the prefix it needs. */
  private openLine(at: number): void {
    if (this.lineOpen) return

    const needed =
      this.text.length === 0
        ? 0
        : Math.max(0, this.pendingBreak - this.trailingNewlines())
    if (needed > 0) this.push("structural", at, at, "\n".repeat(needed))

    this.pendingBreak = 0
    this.pendingSpace = false
    this.lineOpen = true

    this.push("structural", at, at, this.linePrefix())
  }

  /** Ends the current line. `2` asks for a blank line before the next one. */
  break(amount: number): void {
    // A list marker is already waiting for the next line, so a block inside
    // the item must not push a blank line between the bullet and its text.
    const capped = this.pendingMarker !== null ? Math.min(amount, 1) : amount
    this.pendingBreak = Math.max(this.pendingBreak, capped)
    this.pendingSpace = false
    this.lineOpen = false
  }

  /**
   * A run of whitespace between two runs of text.
   *
   * A single space is written as a literal, because it is a character the
   * author typed and, more to the point, because a value written across it has
   * to stay one contiguous range. `John Smith` cut as two ranges either side of
   * an unremovable space writes the marker twice and leaves the space sitting
   * between them.
   *
   * Anything longer is markup indentation rather than text — `<td>
    Alice`
   * is one word — so it collapses to a single structural space, deferred so
   * that a break arriving next drops it instead of leaving a line trailing.
   * Neither happens at a line edge, where the whitespace is pure layout.
   */
  space(start: number, end: number, run: string): void {
    if (!this.lineOpen) return
    if (run === " ") {
      this.content("literal", start, end, " ")
      return
    }
    this.pendingSpace = true
  }

  private flushSpace(at: number): void {
    if (!this.pendingSpace) return
    this.pendingSpace = false
    this.push("structural", at, at, " ")
  }

  /** Text that came from the message, addressed by the bytes it came from. */
  content(
    kind: "literal" | "escape",
    start: number,
    end: number,
    value: string
  ): void {
    if (value.length === 0) return
    this.openLine(start)
    this.flushSpace(start)
    this.push(kind, start, end, value)
  }

  /** Markdown punctuation, which sits on the line but belongs to no one. */
  marker(at: number, value: string): void {
    if (value.length === 0) return
    this.openLine(at)
    this.flushSpace(at)
    this.push("structural", at, at, value)
  }

  // --- blocks ---------------------------------------------------------------

  heading(level: number): void {
    this.break(2)
    this.pendingMarker = `${"#".repeat(level)} `
  }

  rule(at: number): void {
    this.break(2)
    this.marker(at, "---")
    this.break(2)
  }

  openList(ordered: boolean): void {
    this.break(this.lists.length > 0 ? 1 : 2)
    this.lists.push({ ordered, index: 0 })
  }

  closeList(): void {
    this.lists.pop()
    this.break(this.lists.length > 0 ? 1 : 2)
  }

  item(): void {
    this.break(1)
    const frame = this.lists[this.lists.length - 1]
    if (!frame) {
      // A stray `<li>` outside any list still reads as one.
      this.pendingMarker = "- "
      return
    }
    frame.index += 1
    this.pendingMarker = frame.ordered ? `${frame.index}. ` : "- "
  }

  openQuote(): void {
    this.break(2)
    this.quote += 1
  }

  closeQuote(): void {
    this.quote = Math.max(0, this.quote - 1)
    this.break(2)
  }

  openPre(at: number): void {
    this.break(2)
    this.marker(at, "```")
    this.break(1)
    this.pre += 1
  }

  closePre(at: number): void {
    this.pre = Math.max(0, this.pre - 1)
    this.break(1)
    this.marker(at, "```")
    this.break(2)
  }

  get inPre(): boolean {
    return this.pre > 0
  }

  // --- tables ---------------------------------------------------------------

  openTable(): void {
    this.break(2)
    this.tables.push({ rows: 0, cells: 0, piped: false })
  }

  closeTable(): void {
    this.tables.pop()
    this.break(2)
  }

  /**
   * Starts a row, deciding whether it is a row of data or a row of layout.
   *
   * Email markup nests single-cell tables for layout the way a print designer
   * nests frames — five deep is ordinary — and rendering those as tables hands
   * a reviewer a page of `| |`. So a row is written with pipes only when it
   * actually has more than one cell, or a header cell; otherwise its content
   * is written as ordinary blocks. Counting the cells means looking ahead to
   * the row's own close tag, which is a bounded scan over markup already read.
   */
  openRow(source: string, from: number): void {
    this.break(1)
    const frame = this.tables[this.tables.length - 1]
    if (!frame) return
    frame.cells = 0
    frame.piped = countCells(source, from) > 1
  }

  cell(at: number, header: boolean): void {
    const frame = this.tables[this.tables.length - 1]
    if (!frame) return

    if (header) frame.piped = true
    if (!frame.piped) {
      // Layout, not data: the cell is just another block.
      this.break(1)
      return
    }

    this.marker(at, frame.cells === 0 ? "| " : " | ")
    frame.cells += 1
  }

  closeRow(at: number): void {
    const frame = this.tables[this.tables.length - 1]
    if (!frame) return

    if (!frame.piped || frame.cells === 0) {
      this.break(1)
      return
    }

    this.marker(at, " |")
    if (frame.rows === 0) {
      // Markdown needs the header rule, and the renderer reads the first row
      // of a run as its header. One structural atom, because none of it came
      // from the message.
      const columns: string[] = new Array(frame.cells).fill("---")
      this.push("structural", at, at, `\n| ${columns.join(" | ")} |`)
    }

    frame.rows += 1
    frame.cells = 0
    this.break(1)
  }

  // --- inline ---------------------------------------------------------------

  emphasis(
    at: number,
    kind: "bold" | "italic" | "code",
    opening: boolean
  ): void {
    if (this.pre > 0) return

    const marks = { bold: "**", italic: "*", code: "`" } as const

    if (opening) {
      if (this[kind] === 0) this.marker(at, marks[kind])
      this[kind] += 1
      return
    }

    if (this[kind] === 0) return
    this[kind] -= 1
    // Only the outermost close writes the mark, or nested emphasis produces
    // `****` and the renderer sees an empty run.
    if (this[kind] === 0) this.marker(at, marks[kind])
  }
}

/**
 * How many cells the row starting at `from` contains, up to its close tag.
 *
 * Counted at this row's own nesting depth. A layout cell holding another table
 * is extremely ordinary in email, and counting that table's cells as this
 * row's would read a one-cell wrapper as a two-column table and pipe both.
 */
function countCells(source: string, from: number): number {
  const pattern = /<(\/?)(table|tr|td|th)[\s>/]/gi
  pattern.lastIndex = from

  let depth = 0
  let count = 0

  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const closing = match[1] === "/"
    const name = match[2].toLowerCase()

    if (name === "table") {
      // A `</table>` at depth zero closes the table this row is in, which the
      // row's own close tag should have done first. Malformed, and the count
      // ends here either way.
      if (closing && depth === 0) break
      depth += closing ? -1 : 1
      continue
    }

    if (depth > 0) continue
    if (closing) {
      if (name === "tr") break
      continue
    }
    if (name === "td" || name === "th") count += 1
  }

  return count
}

/**
 * Walks the markup once.
 *
 * Deliberately not a DOM parse. Building a tree and serializing it back would
 * rewrite every byte of the message — attribute quoting, tag case, whitespace,
 * the things mail clients are famously particular about — to remove a name.
 * A scan keeps every byte outside a removed range exactly as it arrived.
 */
export function parseHtmlText(source: string): HtmlText {
  const writer = new MarkdownWriter()
  const attributes: HtmlText["attributes"] = []

  /** Anchors whose `](url)` tail is still owed, innermost last. */
  const anchors: (Attribute | null)[] = []

  let index = 0
  const length = source.length

  while (index < length) {
    const character = source[index]

    if (character === "<") {
      const tagEnd = source.indexOf(">", index)
      if (tagEnd === -1) {
        // An unterminated tag: everything after it is markup we cannot read,
        // and reading it as text would offer the reviewer angle brackets.
        break
      }

      const tag = source.slice(index, tagEnd + 1)
      const closing = tag.startsWith("</")
      const name = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1]?.toLowerCase()

      if (name && OPAQUE.has(name) && !closing) {
        const close = source.toLowerCase().indexOf(`</${name}`, tagEnd + 1)
        index = close === -1 ? length : close
        continue
      }

      if (name) {
        writeTag(writer, name, closing, tag, index, tagEnd, source, anchors)
      }

      if (!closing) collectAttributes(tag, index, attributes)

      index = tagEnd + 1
      continue
    }

    if (character === "&") {
      const semicolon = source.indexOf(";", index)
      if (semicolon !== -1 && semicolon - index <= 10) {
        const entity = source.slice(index, semicolon + 1)
        const decoded = decodeEntity(entity)
        if (decoded !== null) {
          // Several bytes for one character: it goes whole or not at all, or
          // what follows it is corrupted.
          writer.content("escape", index, semicolon + 1, decoded)
          index = semicolon + 1
          continue
        }
      }
      writer.content("literal", index, index + 1, "&")
      index += 1
      continue
    }

    let end = index
    while (end < length && source[end] !== "<" && source[end] !== "&") end += 1

    if (writer.inPre) {
      writer.content("literal", index, end, source.slice(index, end))
      index = end
      continue
    }

    // Outside `<pre>`, markup indentation is not text: runs of whitespace
    // collapse to one structural space, and to nothing at a line boundary.
    let cursor = index
    while (cursor < end) {
      const whitespace = /\s/.test(source[cursor])
      let run = cursor
      while (run < end && /\s/.test(source[run]) === whitespace) run += 1

      const value = source.slice(cursor, run)
      if (whitespace) writer.space(cursor, run, value)
      else writer.content("literal", cursor, run, value)

      cursor = run
    }

    index = end
  }

  return { text: writer.text, atoms: writer.atoms, attributes }
}

/** Applies one tag's structural meaning to the writer. */
function writeTag(
  writer: MarkdownWriter,
  name: string,
  closing: boolean,
  tag: string,
  start: number,
  tagEnd: number,
  source: string,
  anchors: (Attribute | null)[]
): void {
  const heading = /^h([1-6])$/.exec(name)
  if (heading) {
    if (closing) writer.break(2)
    else writer.heading(Number(heading[1]))
    return
  }

  switch (name) {
    case "br":
      writer.break(1)
      return
    case "hr":
      writer.rule(start)
      return

    case "ul":
    case "ol":
      if (closing) writer.closeList()
      else writer.openList(name === "ol")
      return
    case "li":
      if (closing) writer.break(1)
      else writer.item()
      return

    case "blockquote":
      if (closing) writer.closeQuote()
      else writer.openQuote()
      return

    case "pre":
      if (closing) writer.closePre(start)
      else writer.openPre(start)
      return

    case "table":
      if (closing) writer.closeTable()
      else writer.openTable()
      return
    case "tr":
      if (closing) writer.closeRow(start)
      else writer.openRow(source, tagEnd + 1)
      return
    case "td":
    case "th":
      if (!closing) writer.cell(start, name === "th")
      return

    case "strong":
    case "b":
      writer.emphasis(start, "bold", !closing)
      return
    case "em":
    case "i":
      writer.emphasis(start, "italic", !closing)
      return
    case "code":
    case "tt":
      writer.emphasis(start, "code", !closing)
      return

    case "a": {
      if (closing) {
        const anchor = anchors.pop()
        if (!anchor) return
        writer.marker(start, "](")
        writer.content("literal", anchor.start, anchor.end, anchor.value)
        writer.marker(start, ")")
        return
      }

      // A link with nothing behind it is just text; writing `[text]()` around
      // it would be punctuation the reviewer reads past for nothing.
      const href = attributeOf(tag, start, "href")
      anchors.push(href)
      if (href) writer.marker(start, "[")
      return
    }

    case "img": {
      if (closing) return
      const alt = attributeOf(tag, start, "alt")
      writer.marker(start, "![")
      // The alt text is the message's own words and can name somebody, so it
      // is addressed like any other content. The `src` is not written: a
      // newsletter's CDN URLs would drown the text, and the sweep still
      // reaches them through the attribute list.
      if (alt) writer.content("literal", alt.start, alt.end, alt.value)
      else writer.marker(start, "image")
      writer.marker(start, "]")
      return
    }

    default:
      if (BLOCK.has(name)) writer.break(2)
      else if (LINE.has(name)) writer.break(1)
  }
}

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/

/** One named attribute of a tag, with the byte range of its value. */
function attributeOf(
  tag: string,
  tagStart: number,
  wanted: string
): Attribute | null {
  const pattern = new RegExp(ATTRIBUTE.source, "g")

  let match: RegExpExecArray | null
  while ((match = pattern.exec(tag)) !== null) {
    if (match[1].toLowerCase() !== wanted) continue

    const value = match[3] ?? match[4] ?? ""
    if (value.length === 0) return null

    const quoteOffset = match.index + match[0].indexOf(match[2]) + 1
    return {
      value,
      start: tagStart + quoteOffset,
      end: tagStart + quoteOffset + value.length,
    }
  }

  return null
}

function collectAttributes(
  tag: string,
  tagStart: number,
  into: HtmlText["attributes"]
): void {
  const pattern = new RegExp(ATTRIBUTE.source, "g")

  let match: RegExpExecArray | null
  while ((match = pattern.exec(tag)) !== null) {
    if (!TEXT_ATTRIBUTES.has(match[1].toLowerCase())) continue

    const value = match[3] ?? match[4] ?? ""
    if (value.length === 0) continue

    // The offset of the value itself, inside the quotes.
    const quoteOffset = match.index + match[0].indexOf(match[2]) + 1
    into.push({
      value,
      start: tagStart + quoteOffset,
      end: tagStart + quoteOffset + value.length,
    })
  }
}
