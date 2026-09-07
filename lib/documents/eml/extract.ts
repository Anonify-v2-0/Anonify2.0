import {
  bodyAddress,
  filenameAddress,
  headerAddress,
} from "@/lib/documents/eml/address"
import { parseHtmlText, type HtmlText } from "@/lib/documents/eml/html"
import { emlLimits, type EmlLimits } from "@/lib/documents/eml/limits"
import {
  decodeEml,
  parseEml,
  type MimeNode,
  type ParsedMessage,
} from "@/lib/documents/eml/parse"
import { TextStreamBuilder } from "@/lib/documents/shared/text"
import { CHARS_PER_PAGE } from "@/lib/documents/text/extract"
import type {
  NormalizedDocument,
  NormalizedPage,
  PageSection,
  PageSectionKind,
} from "@/types/document"

/**
 * Email extraction.
 *
 * The output is the same normalized model every other pipeline produces —
 * pages of text with addressed spans — but what goes into it is deliberately
 * everything, in document order:
 *
 *   the message's headers, one span each
 *   each text part's content, one span per line
 *   each HTML part's visible text as markdown, one span per run
 *   each attachment's filename
 *   and all of the above again, recursively, for every nested message
 *
 * The reason for the completeness is the failure this tool exists to prevent.
 * A person's name in a message is almost never in one place: it is in From, in
 * the greeting, in the HTML alternative of that greeting, in the quoted reply
 * three messages down, and in the attachment called
 * `2024-review-john-smith.pdf`. Extracting "the body" finds one of those five
 * and lets the reviewer believe they have seen the message.
 *
 * Which of those a stretch of the page is comes back as a `PageSection`, so
 * the viewer can name it and fold it rather than drawing one undifferentiated
 * stream. The blank lines between sections are padding rather than spans, so
 * nothing can be redacted there: there is nothing there, and a redaction must
 * always name characters that came from the message.
 */

/** Headers worth putting in front of a reviewer, in the order they are shown. */
export const REVIEWED_HEADERS = [
  "from",
  "sender",
  "reply-to",
  "to",
  "cc",
  "bcc",
  "subject",
  "date",
  "return-path",
  "message-id",
  "in-reply-to",
  "references",
  "received",
  "x-original-to",
  "delivered-to",
] as const

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

export type EmlExtraction = {
  document: NormalizedDocument
  parsed: ParsedMessage
  source: string
}

/** What a run of pieces belongs to, carried through into the page. */
type Section = Omit<PageSection, "start" | "end">

/**
 * A piece of the reviewed stream: either an addressed span or plain padding.
 *
 * `section` says which part of the message the piece came from. Pieces that
 * carry none are the blank lines between sections, which belong to nothing
 * because there is nothing there.
 */
type Piece = { id: string | null; text: string; section?: Section }

function headerPieces(node: MimeNode, into: Piece[], section: Section): void {
  const shown = node.headers.filter((header) =>
    (REVIEWED_HEADERS as readonly string[]).includes(header.name)
  )
  if (shown.length === 0) return

  // Ordered as the list is written rather than as the message wrote them, so
  // two messages read the same way regardless of what a relay prepended.
  const ordered = [...shown].sort((a, b) => {
    const rank =
      REVIEWED_HEADERS.indexOf(a.name as (typeof REVIEWED_HEADERS)[number]) -
      REVIEWED_HEADERS.indexOf(b.name as (typeof REVIEWED_HEADERS)[number])
    return rank !== 0 ? rank : a.index - b.index
  })

  for (const header of ordered) {
    if (header.value.length === 0) continue
    into.push({ id: null, text: `${header.rawName}: `, section })
    into.push({
      id: headerAddress(node.path, header.name, header.index),
      text: header.value,
      section,
    })
    into.push({ id: null, text: "\n", section })
  }
}

/** One span per line, each addressed by its offset in the part's own text. */
function textPieces(
  path: string,
  text: string,
  into: Piece[],
  section: Section
): void {
  let cursor = 0
  const pattern = /\r\n|\r|\n/g

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const line = text.slice(cursor, match.index)
    if (line.length > 0) {
      into.push({ id: bodyAddress(path, cursor), text: line, section })
    }
    into.push({ id: null, text: "\n", section })
    cursor = match.index + match[0].length
  }

  const last = text.slice(cursor)
  if (last.length > 0) {
    into.push({ id: bodyAddress(path, cursor), text: last, section })
    into.push({ id: null, text: "\n", section })
  }
}

/**
 * One span per run of text between two pieces of markdown.
 *
 * The plain-text pipeline can split on newlines because a text part has
 * nothing else in it. An HTML part does: its atoms already say which
 * characters came from the message and which this code wrote to give the
 * message its shape, and those are exactly the span/padding boundaries a
 * reviewer needs. A `## ` or a `| ` is not something anyone can redact,
 * because there is nothing there — the same rule the section labels follow.
 *
 * Spans are addressed by their offset in the part's decoded text, which is
 * what `redactEml` translates back through the same parse. Runs are split at
 * newlines so a span never crosses a line and the viewer can read the page one
 * line at a time.
 */
function htmlPieces(
  path: string,
  html: HtmlText,
  into: Piece[],
  section: Section
): void {
  const { text, atoms } = html

  let runStart: number | null = null
  let runEnd = 0

  const flush = () => {
    if (runStart === null) return

    let cursor = runStart
    for (let at = runStart; at < runEnd; at++) {
      if (text[at] !== "\n") continue
      if (at > cursor) {
        into.push({
          id: bodyAddress(path, cursor),
          text: text.slice(cursor, at),
          section,
        })
      }
      into.push({ id: null, text: "\n", section })
      cursor = at + 1
    }

    if (runEnd > cursor) {
      into.push({
        id: bodyAddress(path, cursor),
        text: text.slice(cursor, runEnd),
        section,
      })
    }

    runStart = null
  }

  for (const atom of atoms) {
    if (atom.kind === "structural") {
      flush()
      into.push({
        id: null,
        text: text.slice(atom.textStart, atom.textEnd),
        section,
      })
      continue
    }

    if (runStart === null) runStart = atom.textStart
    runEnd = atom.textEnd
  }

  flush()
}

/**
 * Where a message's parts sit, so the viewer can name and fold them.
 *
 * The labels used to be written into the stream — `[text/html]`, `[forwarded
 * message]` — as padding nobody could redact. They are metadata now, which is
 * what they always were: the interface draws a section header from them, and
 * the reviewed text is only the message.
 */
function sectionFor(
  kind: PageSectionKind,
  id: string,
  label: string,
  depth: number,
  markdown = false
): Section {
  return {
    id,
    kind,
    label,
    ...(markdown ? { markdown: true } : {}),
    ...(depth > 0 ? { depth } : {}),
  }
}

/** A blank line between two sections, belonging to neither. */
function separate(into: Piece[]): void {
  if (into.length === 0) return
  into.push({ id: null, text: "\n" })
}

function collect(
  node: MimeNode,
  into: Piece[],
  message: string,
  depth: number
): void {
  if (node.path === "0" || node.path.endsWith(".msg")) {
    message = node.path
    if (node.path !== "0") depth += 1

    separate(into)
    headerPieces(
      node,
      into,
      sectionFor(
        "headers",
        `headers:${node.path}`,
        depth === 0 ? "Headers" : "Forwarded message",
        depth
      )
    )
  }

  if (node.nested) {
    collect(node.nested, into, message, depth)
    return
  }

  if (node.children.length > 0) {
    for (const child of node.children) collect(child, into, message, depth)
    return
  }

  if (node.attachment) {
    // All of one message's attachments share a section, so consecutive ones
    // fold together as the list they are rather than as a row each.
    const section = sectionFor(
      "attachments",
      `attachments:${message}`,
      "Attachments",
      depth
    )
    if (into[into.length - 1]?.section?.id !== section.id) separate(into)

    into.push({ id: null, text: `[attachment: ${node.contentType}] `, section })
    if (node.filename) {
      into.push({ id: filenameAddress(node.path), text: node.filename, section })
    }
    into.push({ id: null, text: "\n", section })
    return
  }

  if (node.text === null) return

  separate(into)

  if (node.contentType === "text/html") {
    // The visible text as markdown, not the markup. Offsets address the
    // *decoded* text, which is what the exporter translates back through the
    // same parse.
    htmlPieces(
      node.path,
      parseHtmlText(node.text),
      into,
      sectionFor("html", `body:${node.path}`, node.contentType, depth, true)
    )
    return
  }

  textPieces(
    node.path,
    node.text,
    into,
    sectionFor("text", `body:${node.path}`, node.contentType, depth)
  )
}

/**
 * Groups the stream into pages, never splitting a piece across a boundary.
 *
 * Sections are recorded per page rather than per message, because a body
 * longer than a page is cut by the same rule everything else is and both
 * halves still have to say what they are. The offsets are into the page's own
 * text, so they survive whatever pagination does; the section's `id` is what
 * makes both halves the same section to a reader who folds it.
 */
function paginate(pieces: Piece[]): NormalizedPage[] {
  const pages: NormalizedPage[] = []
  let builder = new TextStreamBuilder()
  let sections: PageSection[] = []
  let used = 0

  const flush = () => {
    pages.push({
      number: pages.length + 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      text: builder.text,
      spans: builder.spans,
      ...(sections.length > 0 ? { sections } : {}),
    })
    builder = new TextStreamBuilder()
    sections = []
    used = 0
  }

  for (const piece of pieces) {
    if (used > 0 && used + piece.text.length > CHARS_PER_PAGE) flush()

    const start = builder.length
    if (piece.id) builder.append(piece.id, piece.text)
    else builder.pad(piece.text)

    if (piece.section) {
      const last = sections[sections.length - 1]
      if (last && last.id === piece.section.id && last.end === start) {
        last.end = builder.length
      } else {
        sections.push({ ...piece.section, start, end: builder.length })
      }
    }

    used += piece.text.length
  }

  if (builder.text.length > 0 || pages.length === 0) flush()
  return pages
}

export function extractEml(
  documentId: string,
  bytes: Uint8Array,
  limits: EmlLimits = emlLimits()
): EmlExtraction {
  const source = decodeEml(bytes)
  const parsed = parseEml(source, limits)

  const pieces: Piece[] = []
  collect(parsed.root, pieces, "0", 0)

  const pages = paginate(pieces)

  const attachments = parsed.nodes.filter((node) => node.attachment)
  const nested = parsed.nodes.filter((node) => node.contentType === "message/rfc822")

  return {
    source,
    parsed,
    document: {
      documentId,
      kind: "eml",
      pages,
      metadata: {
        pageCount: pages.length,
        parts: parsed.nodes.length,
        attachments: attachments.length,
        nestedMessages: nested.length,
        // What the quota is charged on, so the number the user is billed for
        // is the number this pipeline actually read.
        textBytes: pages.reduce(
          (total, page) => total + Buffer.byteLength(page.text, "utf8"),
          0
        ),
        contentTypes: [
          ...new Set(parsed.nodes.map((node) => node.contentType)),
        ].sort(),
      },
    },
  }
}
