import type { SourceAtom } from "@/lib/documents/shared/atoms"

/**
 * The visible text of an HTML body, and the map back to it.
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
 * become literals, entities become escapes, and a `<br>` or a block tag
 * becomes structure — it contributes a line break so the reviewed text reads
 * as the message does, and it is never removed.
 *
 * Script and style contents are skipped entirely. They are not visible text,
 * they are full of strings that look like text, and offering a reviewer a
 * CSS selector to redact would be noise at best.
 *
 * Attribute values are collected separately. They are not shown as reviewable
 * text — an address that appears only inside an `href` is not something a
 * person is reading — but the accepted-value sweep does reach them, because a
 * `mailto:` link is a copy of the address whatever it looks like on screen.
 */

export type HtmlText = {
  /** Visible text, in document order. */
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

/** Tags that end a line, so the reviewed text reads the way the email does. */
const BREAKING = new Set([
  "br",
  "p",
  "div",
  "tr",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "table",
  "ul",
  "ol",
  "hr",
  "section",
  "article",
  "pre",
])

/** Attributes that can carry a copy of a value shown elsewhere. */
const TEXT_ATTRIBUTES = new Set(["href", "src", "alt", "title", "value"])

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
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

/**
 * Walks the markup once.
 *
 * Deliberately not a DOM parse. Building a tree and serializing it back would
 * rewrite every byte of the message — attribute quoting, tag case, whitespace,
 * the things mail clients are famously particular about — to remove a name.
 * A scan keeps every byte outside a removed range exactly as it arrived.
 */
export function parseHtmlText(source: string): HtmlText {
  const atoms: SourceAtom[] = []
  const attributes: HtmlText["attributes"] = []
  let text = ""

  const emit = (
    kind: SourceAtom["kind"],
    start: number,
    end: number,
    value: string
  ) => {
    if (value.length === 0) return
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

    if (character === "<") {
      const tagEnd = source.indexOf(">", index)
      if (tagEnd === -1) {
        // An unterminated tag: everything after it is markup we cannot read,
        // and reading it as text would offer the reviewer angle brackets.
        break
      }

      const tag = source.slice(index, tagEnd + 1)
      const name = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1]?.toLowerCase()

      if (name && OPAQUE.has(name) && !tag.startsWith("</")) {
        const close = source
          .toLowerCase()
          .indexOf(`</${name}`, tagEnd + 1)
        index = close === -1 ? length : close
        continue
      }

      if (name && BREAKING.has(name)) {
        emit("structural", index, tagEnd + 1, "\n")
      }

      if (!tag.startsWith("</")) {
        collectAttributes(tag, index, attributes)
      }

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
          emit("escape", index, semicolon + 1, decoded)
          index = semicolon + 1
          continue
        }
      }
      emit("literal", index, index + 1, "&")
      index += 1
      continue
    }

    let end = index
    while (end < length && source[end] !== "<" && source[end] !== "&") end += 1
    emit("literal", index, end, source.slice(index, end))
    index = end
  }

  return { text, atoms, attributes }
}

function collectAttributes(
  tag: string,
  tagStart: number,
  into: HtmlText["attributes"]
): void {
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g

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
