import { describe, expect, it } from "vitest"

import { extractEml } from "@/lib/documents/eml/extract"
import {
  cellsOf,
  inlineRuns,
  linesOf,
  piecesOf,
  sectionsOf,
  type MarkdownLine,
} from "@/lib/documents/eml/markdown"
import type { NormalizedPage } from "@/types/document"

import { bytesOf, EML, richHtmlEml, simpleEml } from "./eml-fixtures"

/**
 * Reading an extracted message back the way the viewer does.
 *
 * The contract under test is the one the whole scheme rests on: block structure
 * is read off the *padding*, never off the span text. A sender who writes `- `
 * or `# ` or `|` themselves must get a paragraph containing those characters,
 * because their text is a span and a span is never looked inside.
 */

function pageOf(source: string): NormalizedPage {
  return extractEml("doc", bytesOf(source)).document.pages[0]
}

/** The lines of the page's markdown, which is the body of an HTML part. */
function markdownLines(page: NormalizedPage): MarkdownLine[] {
  const section = sectionsOf(page).find((candidate) => candidate.markdown)
  if (!section) throw new Error("the page carries no markdown")
  return linesOf(page, section.start, section.end)
}

function textOf(line: MarkdownLine): string {
  return line.pieces.map((piece) => piece.text).join("")
}

describe("splitting a page into markdown and flat stream", () => {
  it("leaves a message with no HTML entirely flat", () => {
    const page = pageOf(simpleEml())
    const sections = sectionsOf(page)

    expect(sections.every((section) => !section.markdown)).toBe(true)
    // Whatever the split, it covers the page exactly once and in order.
    expect(sections.map((section) => section.end).at(-1)).toBe(page.text.length)
  })

  it("covers the page exactly, with the headers outside the markdown", () => {
    const page = pageOf(richHtmlEml())
    const sections = sectionsOf(page)

    let cursor = 0
    for (const section of sections) {
      expect(section.start).toBe(cursor)
      cursor = section.end
    }
    expect(cursor).toBe(page.text.length)

    const first = sections[0]
    expect(first.markdown).toBe(false)
    expect(page.text.slice(first.start, first.end)).toContain("Subject:")
  })
})

describe("reading a line's block type", () => {
  it("recognises the blocks an HTML body was written as", () => {
    const lines = markdownLines(pageOf(richHtmlEml()))
    const kinds = (kind: MarkdownLine["kind"]) =>
      lines.filter((line) => line.kind === kind)

    const heading = kinds("heading")[0]
    expect(heading.level).toBe(1)
    expect(textOf(heading)).toBe("Quarterly review")

    expect(kinds("item").map(textOf)).toEqual([EML.colleague, "Bob Chen"])
    expect(kinds("item").every((line) => !line.ordered)).toBe(true)

    // The header rule the extractor writes under a table's first row.
    expect(kinds("separator")).toHaveLength(1)
    expect(kinds("row")).toHaveLength(2)

    const quoted = lines.filter((line) => line.quote > 0)
    expect(quoted.map(textOf)).toEqual(["On Tue, Bob wrote:"])
  })

  it("consumes the marker, so a line's pieces are only its content", () => {
    const lines = markdownLines(pageOf(richHtmlEml()))
    const heading = lines.find((line) => line.kind === "heading")!

    expect(textOf(heading)).not.toContain("#")
    expect(heading.pieces.some((piece) => piece.span !== null)).toBe(true)
  })

  it("never reads a block marker out of a sender's own text", () => {
    // Everything here is span text, and none of it is padding: a sender who
    // writes a hyphen, a hash or a pipe is writing prose.
    const page = pageOf(
      htmlMessage("<p># not a heading</p><p>- not a bullet</p><p>a | b</p>")
    )
    const lines = markdownLines(page).filter((line) => line.kind !== "blank")

    expect(lines.map((line) => line.kind)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
    ])
    expect(lines.map(textOf)).toEqual([
      "# not a heading",
      "- not a bullet",
      "a | b",
    ])
  })

  it("keeps a line that opens with emphasis as a paragraph", () => {
    const lines = markdownLines(pageOf(htmlMessage("<p><b>Urgent</b>: read</p>")))
    const line = lines.find((candidate) => candidate.kind === "paragraph")!

    // The `**` is padding, but it matches no block marker, so it stays for the
    // inline pass rather than being eaten as a prefix.
    expect(textOf(line)).toBe("**Urgent**: read")
  })
})

describe("splitting a table row into cells", () => {
  it("gives one cell per column, without the pipes", () => {
    const lines = markdownLines(pageOf(richHtmlEml()))
    const rows = lines
      .filter((line) => line.kind === "row")
      .map((line) => cellsOf(line.pieces))

    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toHaveLength(2)

    const cellText = (cells: (typeof rows)[number]) =>
      cells.map((cell) =>
        cell
          .map((piece) => piece.text)
          .join("")
          .trim()
      )

    expect(cellText(rows[0])).toEqual(["Name", "Role"])
    expect(cellText(rows[1])).toEqual([EML.person, "Chair"])
  })

  it("keeps each cell's span, so a name in a table is still redactable", () => {
    const lines = markdownLines(pageOf(richHtmlEml()))
    const row = lines.filter((line) => line.kind === "row")[1]
    const [name] = cellsOf(row.pieces)

    const span = name.find((piece) => piece.span !== null)?.span
    expect(span?.text).toBe(EML.person)
    expect(span?.id).toMatch(/^part:0\/body#\d+$/)
  })
})

describe("reading a line's inline runs", () => {
  it("carries emphasis without letting the markers become text", () => {
    const lines = markdownLines(pageOf(htmlMessage("<p>Call <b>Ada</b> now</p>")))
    const runs = inlineRuns(lines.find((line) => line.kind === "paragraph")!.pieces)

    expect(runs.map((run) => run.text).join("")).toBe("Call Ada now")
    expect(runs.find((run) => run.text === "Ada")?.bold).toBe(true)
    expect(runs.every((run) => !run.text.includes("*"))).toBe(true)
  })

  it("shows a link's target beside its text, both still spans", () => {
    const lines = markdownLines(
      pageOf(htmlMessage(`<p><a href="mailto:${EML.email}">the chair</a></p>`))
    )
    const runs = inlineRuns(lines.find((line) => line.kind === "paragraph")!.pieces)

    const link = runs.find((run) => run.role === "link")
    const url = runs.find((run) => run.role === "url" && run.spanId)

    expect(link?.text).toBe("the chair")
    // The target is a copy of a value the message may be hiding, so it stays
    // on screen and stays addressable rather than disappearing into an href.
    expect(url?.text).toBe(`mailto:${EML.email}`)
    expect(url?.spanId).toBeTruthy()
    expect(runs.map((run) => run.text).join("")).toBe(
      `the chair (mailto:${EML.email})`
    )
  })

  it("draws an image as its alt text and nothing else", () => {
    const lines = markdownLines(
      pageOf(htmlMessage('<p><img src="https://t.example/p.gif" alt="Ada at work"></p>'))
    )
    const runs = inlineRuns(lines.find((line) => line.kind === "paragraph")!.pieces)

    expect(runs.map((run) => run.text).join("")).toBe("Ada at work")
    expect(runs.every((run) => run.role === "image")).toBe(true)
    expect(runs.some((run) => run.text.includes("t.example"))).toBe(false)
  })

  it("gives every character of the line back exactly once", () => {
    const page = pageOf(richHtmlEml())

    for (const line of markdownLines(page)) {
      const runs = inlineRuns(line.pieces)
      const spans = runs.filter((run) => run.spanId)
      // Content is never duplicated and never dropped; only the extractor's
      // own punctuation is added or removed.
      expect(spans.map((run) => run.text).join("")).toBe(
        line.pieces
          .filter((piece) => piece.span)
          .map((piece) => piece.text)
          .join("")
      )
    }
  })
})

describe("walking a page into pieces", () => {
  it("returns the page's characters in order, spans and padding alike", () => {
    const page = pageOf(richHtmlEml())
    const pieces = piecesOf(page, 0, page.text.length)

    expect(pieces.map((piece) => piece.text).join("")).toBe(page.text)
    for (const piece of pieces) {
      expect(page.text.slice(piece.start, piece.end)).toBe(piece.text)
    }
  })

  it("clips a span that straddles the end of the range", () => {
    const page = pageOf(richHtmlEml())
    const span = page.spans[0]
    const cut = span.start + 1

    const pieces = piecesOf(page, 0, cut)
    expect(pieces.map((piece) => piece.text).join("")).toBe(
      page.text.slice(0, cut)
    )
  })
})

/** A minimal message whose only body is the given markup. */
function htmlMessage(body: string): string {
  return [
    `From: ${EML.person} <${EML.email}>`,
    "Subject: Test",
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="utf-8"',
    "",
    `<html><body>${body}</body></html>`,
    "",
  ].join("\r\n")
}
