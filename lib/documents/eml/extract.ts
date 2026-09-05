import {
  bodyAddress,
  filenameAddress,
  headerAddress,
} from "@/lib/documents/eml/address"
import { parseHtmlText } from "@/lib/documents/eml/html"
import { emlLimits, type EmlLimits } from "@/lib/documents/eml/limits"
import {
  decodeEml,
  parseEml,
  type MimeNode,
  type ParsedMessage,
} from "@/lib/documents/eml/parse"
import { TextStreamBuilder } from "@/lib/documents/shared/text"
import { CHARS_PER_PAGE } from "@/lib/documents/text/extract"
import type { NormalizedDocument, NormalizedPage } from "@/types/document"

/**
 * Email extraction.
 *
 * The output is the same normalized model every other pipeline produces —
 * pages of text with addressed spans — but what goes into it is deliberately
 * everything, in document order:
 *
 *   the message's headers, one span each
 *   each text part's content, one span per line
 *   each HTML part's *visible* text, one span per line
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
 * The labels between sections are padding rather than spans, so nothing can be
 * redacted there: there is nothing there, and a redaction must always name
 * characters that came from the message.
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

/** A piece of the reviewed stream: either an addressed span or plain padding. */
type Piece = { id: string | null; text: string }

function headerPieces(node: MimeNode, into: Piece[]): void {
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
    into.push({ id: null, text: `${header.rawName}: ` })
    into.push({
      id: headerAddress(node.path, header.name, header.index),
      text: header.value,
    })
    into.push({ id: null, text: "\n" })
  }
}

/** One span per line, each addressed by its offset in the part's own text. */
function textPieces(path: string, text: string, into: Piece[]): void {
  let cursor = 0
  const pattern = /\r\n|\r|\n/g

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const line = text.slice(cursor, match.index)
    if (line.length > 0) into.push({ id: bodyAddress(path, cursor), text: line })
    into.push({ id: null, text: "\n" })
    cursor = match.index + match[0].length
  }

  const last = text.slice(cursor)
  if (last.length > 0) {
    into.push({ id: bodyAddress(path, cursor), text: last })
    into.push({ id: null, text: "\n" })
  }
}

function describePart(node: MimeNode): string {
  const quoted =
    node.contentType === "text/plain" || node.contentType === "text/html"
  return quoted ? `\n[${node.contentType}]\n` : `\n[${node.contentType}]\n`
}

function collect(node: MimeNode, into: Piece[]): void {
  if (node.path === "0" || node.path.endsWith(".msg")) {
    into.push({ id: null, text: node.path === "0" ? "" : "\n[forwarded message]\n" })
    headerPieces(node, into)
  }

  if (node.nested) {
    collect(node.nested, into)
    return
  }

  if (node.children.length > 0) {
    for (const child of node.children) collect(child, into)
    return
  }

  if (node.attachment) {
    into.push({ id: null, text: `\n[attachment: ${node.contentType}] ` })
    if (node.filename) {
      into.push({ id: filenameAddress(node.path), text: node.filename })
    }
    into.push({ id: null, text: "\n" })
    return
  }

  if (node.text === null) return

  into.push({ id: null, text: describePart(node) })

  if (node.contentType === "text/html") {
    // The visible text, not the markup. Offsets address the *decoded* text,
    // which is what the exporter translates back through the same parse.
    textPieces(node.path, parseHtmlText(node.text).text, into)
    return
  }

  textPieces(node.path, node.text, into)
}

/** Groups the stream into pages, never splitting a piece across a boundary. */
function paginate(pieces: Piece[]): NormalizedPage[] {
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

  for (const piece of pieces) {
    if (used > 0 && used + piece.text.length > CHARS_PER_PAGE) flush()

    if (piece.id) builder.append(piece.id, piece.text)
    else builder.pad(piece.text)
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
  collect(parsed.root, pieces)

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
