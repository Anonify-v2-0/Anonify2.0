import type { NormalizedPage, PageSection, TextSpan } from "@/types/document"

/**
 * Reading back the markdown an email body was extracted as.
 *
 * `lib/documents/eml/html.ts` writes an HTML body out as markdown so a reviewer
 * sees the message rather than its debris. This is the other half: turning that
 * back into blocks and runs a viewer can draw.
 *
 * ## Why this is not a markdown parser
 *
 * It does not need to be, and a parser would be worse. The page already draws
 * the line this needs: every character that came from the message is inside a
 * span, and every character the extractor wrote to give the message its shape —
 * a `## `, a `| `, a `> ` — is padding between spans.
 *
 * So a line's block type is whatever its *padding* prefix says, and a `- ` a
 * sender actually typed is span text that can never be mistaken for a bullet.
 * That is also why nothing upstream escapes markdown: there is nothing to
 * escape against. A general parser would have to guess; this one is told.
 *
 * Everything here is a pure function of the page, so it is tested without a
 * DOM and the viewer above it stays presentation.
 */

/** A stretch of a page's text: either one span, or the padding beside it. */
export type MarkdownPiece = {
  span: TextSpan | null
  text: string
  start: number
  end: number
}

export type MarkdownLineKind =
  | "heading"
  | "item"
  | "row"
  | "separator"
  | "rule"
  | "fence"
  | "blank"
  | "paragraph"

export type MarkdownLine = {
  /** Offset of the line's first character in the page's text. */
  start: number
  kind: MarkdownLineKind
  /** How many `>` markers the line carries. */
  quote: number
  /** 1-6 for a heading, 0 otherwise. */
  level: number
  /** Nesting depth of a list item. */
  indent: number
  ordered: boolean
  /** Everything after the block marker, as spans and the padding between. */
  pieces: MarkdownPiece[]
}

/**
 * The sections of a page, in reading order.
 *
 * Written by the extractor: a message's headers, each of its bodies, and what
 * it carried. The blank lines between them belong to no section, which is why
 * this is a list of ranges rather than a partition — a viewer draws the
 * sections and there is nothing in the gaps.
 */
export function sectionsOf(page: NormalizedPage): PageSection[] {
  return [...(page.sections ?? [])].sort((a, b) => a.start - b.start)
}

/**
 * The body sections, and which one a reviewer should be looking at.
 *
 * An HTML alternative and the `text/plain` it duplicates are the same message
 * written twice. The HTML is what the sender composed and what the recipient
 * saw, so it is the one that opens; the plain part is the fallback, in both
 * senses.
 */
export function bodySections(page: NormalizedPage): PageSection[] {
  return sectionsOf(page).filter(
    (section) => section.kind === "html" || section.kind === "text"
  )
}

export function activeBodyId(page: NormalizedPage): string | null {
  const bodies = bodySections(page)
  const html = bodies.find((section) => section.kind === "html")
  return (html ?? bodies[0])?.id ?? null
}

/** Walks a range of the page, alternating spans and the gaps between them. */
export function piecesOf(
  page: NormalizedPage,
  from: number,
  to: number
): MarkdownPiece[] {
  const ordered = page.spans
    .filter((span) => span.start < to && span.end > from)
    .sort((a, b) => a.start - b.start)

  const pieces: MarkdownPiece[] = []
  let cursor = from

  for (const span of ordered) {
    const start = Math.max(span.start, from, cursor)
    if (start > cursor) {
      pieces.push({
        span: null,
        text: page.text.slice(cursor, start),
        start: cursor,
        end: start,
      })
    }

    const end = Math.min(span.end, to)
    if (end > start) {
      pieces.push({ span, text: page.text.slice(start, end), start, end })
    }
    cursor = Math.max(cursor, end)
  }

  if (cursor < to) {
    pieces.push({
      span: null,
      text: page.text.slice(cursor, to),
      start: cursor,
      end: to,
    })
  }

  return pieces.filter((piece) => piece.text.length > 0)
}

const QUOTE = /^(?:> ?)+/
const HEADING = /^(#{1,6}) $/
const ITEM = /^( *)(?:[-*]|(\d+)\.) $/
const ROW = /^\| $/
const SEPARATOR = /^\|(?: -+ \|)+$/
const RULE = /^-{3,}$/
const FENCE = /^```$/

/**
 * Reads one line's block type off the padding it starts with.
 *
 * Only padding is consulted, and only a prefix matching a marker *exactly* is
 * consumed. A paragraph opening with `**` keeps its `**`, which the inline pass
 * reads as emphasis.
 */
function classify(
  page: NormalizedPage,
  start: number,
  end: number
): MarkdownLine {
  const pieces = piecesOf(page, start, end)
  const line: MarkdownLine = {
    start,
    kind: "paragraph",
    quote: 0,
    level: 0,
    indent: 0,
    ordered: false,
    pieces,
  }

  if (pieces.length === 0) return { ...line, kind: "blank" }

  const head = pieces[0]
  if (head.span) return line

  let prefix = head.text
  let consumed = 0

  const quote = QUOTE.exec(prefix)
  if (quote) {
    line.quote = (quote[0].match(/>/g) ?? []).length
    consumed += quote[0].length
    prefix = prefix.slice(quote[0].length)
  }

  // Lines that are nothing but padding: a rule, a fence, or the header rule
  // written under a table's first row.
  if (pieces.length === 1) {
    const bare = prefix.trimEnd()
    if (SEPARATOR.test(bare)) return { ...line, kind: "separator", pieces: [] }
    if (RULE.test(bare)) return { ...line, kind: "rule", pieces: [] }
    if (FENCE.test(bare)) return { ...line, kind: "fence", pieces: [] }
    if (bare.length === 0) return { ...line, kind: "blank", pieces: [] }
  }

  const heading = HEADING.exec(prefix)
  const item = heading ? null : ITEM.exec(prefix)

  if (heading) {
    line.kind = "heading"
    line.level = heading[1].length
    consumed += heading[0].length
  } else if (item) {
    line.kind = "item"
    line.indent = Math.floor(item[1].length / 2)
    line.ordered = item[2] !== undefined
    consumed += item[0].length
  } else if (ROW.test(prefix)) {
    line.kind = "row"
    consumed += prefix.length
  }

  if (consumed === 0) return line

  const rest = head.text.slice(consumed)
  line.pieces =
    rest.length > 0
      ? [{ ...head, text: rest, start: head.start + consumed }, ...pieces.slice(1)]
      : pieces.slice(1)

  if (line.pieces.length === 0 && line.kind === "paragraph") line.kind = "blank"
  return line
}

/** Splits a range of the page into classified lines. */
export function linesOf(
  page: NormalizedPage,
  from: number,
  to: number
): MarkdownLine[] {
  const lines: MarkdownLine[] = []
  let cursor = from

  while (cursor <= to) {
    const next = page.text.indexOf("\n", cursor)
    const end = next === -1 || next > to ? to : next
    lines.push(classify(page, cursor, end))
    if (end >= to) break
    cursor = end + 1
  }

  return lines
}

/** Splits a table row's pieces at the `|` characters the extractor wrote. */
export function cellsOf(pieces: MarkdownPiece[]): MarkdownPiece[][] {
  const cells: MarkdownPiece[][] = [[]]

  for (const piece of pieces) {
    if (piece.span) {
      cells[cells.length - 1].push(piece)
      continue
    }

    const parts = piece.text.split("|")
    parts.forEach((part, offset) => {
      if (offset > 0) cells.push([])
      if (part.length > 0) cells[cells.length - 1].push({ ...piece, text: part })
    })
  }

  // The row's closing `|` opens a cell that was never going to hold anything.
  const last = cells[cells.length - 1]
  if (cells.length > 1 && last.every((piece) => !piece.span)) cells.pop()

  return cells
}

/**
 * What a run of inline text is: ordinary, a link's text, a link's target, or
 * the alt text standing in for an image.
 */
export type InlineRole = "text" | "link" | "url" | "image"

export type InlineRun = {
  key: string
  text: string
  /** The span this run draws, or null for punctuation and decoration. */
  spanId: string | null
  bold: boolean
  italic: boolean
  code: boolean
  role: InlineRole
}

/** Inline markers, longest first so `**` is never read as two `*`. */
const MARKERS = ["![", "](", "**", "[", "]", ")", "*", "`"] as const

/**
 * One line's content, as runs carrying the formatting in force where they sit.
 *
 * A link comes back as its text followed by its target, not as an anchor. The
 * target is not decoration: it is a copy of a value the message may be hiding —
 * `mailto:` is the classic — and it is a span like any other, so it has to stay
 * visible and selectable or the reviewer cannot act on it.
 */
export function inlineRuns(pieces: MarkdownPiece[]): InlineRun[] {
  const runs: InlineRun[] = []
  let bold = false
  let italic = false
  let code = false
  let role: InlineRole = "text"

  const push = (key: string, text: string, spanId: string | null, at?: InlineRole) => {
    if (text.length === 0) return
    runs.push({ key, text, spanId, bold, italic, code, role: at ?? role })
  }

  for (const piece of pieces) {
    if (piece.span) {
      push(`s${piece.start}`, piece.text, piece.span.id)
      continue
    }

    let cursor = 0
    let plain = ""

    while (cursor < piece.text.length) {
      const marker = MARKERS.find((candidate) =>
        piece.text.startsWith(candidate, cursor)
      )

      if (!marker) {
        plain += piece.text[cursor]
        cursor += 1
        continue
      }

      push(`p${piece.start}.${cursor}`, plain, null)
      plain = ""
      cursor += marker.length

      switch (marker) {
        case "**":
          bold = !bold
          break
        case "*":
          italic = !italic
          break
        case "`":
          code = !code
          break
        case "![":
          role = "image"
          break
        case "[":
          role = "link"
          break
        case "](":
          role = "url"
          push(`u${piece.start}.${cursor}`, " (", null)
          break
        case ")":
          if (role === "url") {
            push(`u${piece.start}.${cursor}`, ")", null)
            role = "text"
          } else {
            plain += ")"
          }
          break
        case "]":
          if (role === "image" || role === "link") role = "text"
          else plain += "]"
          break
      }
    }

    push(`p${piece.start}.end`, plain, null)
  }

  return runs
}
