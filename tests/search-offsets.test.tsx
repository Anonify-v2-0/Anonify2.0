import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { EmlViewer } from "@/components/document-viewer/eml-viewer"
import { TextViewer } from "@/components/document-viewer/text-viewer"
import { coarseRedactionClass } from "@/components/search/search-highlights"
import { extractEml } from "@/lib/documents/eml/extract"
import { extractText } from "@/lib/documents/text/extract"
import type { NormalizedPage } from "@/types/document"
import type { Redaction } from "@/types/redaction"

import { bytesOf, mixedEml, nestedEml, richHtmlEml } from "./eml-fixtures"

/**
 * Search paints its hits onto the text nodes a viewer already drew, finding
 * them by the `data-offset` each one carries. So every element that carries
 * one has to draw exactly the page text starting at that offset — otherwise a
 * hit is painted over the wrong characters, which on this screen reads as
 * "that is the value", pointing at something else.
 */

function unescape(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
}

/** Every `data-offset` element whose content is plain text, and that text. */
function marked(markup: string): { offset: number; text: string }[] {
  const found: { offset: number; text: string }[] = []
  const pattern = /<span[^>]*\bdata-offset="(\d+)"[^>]*>([^<]*)<\/span>/g
  for (const match of markup.matchAll(pattern)) {
    found.push({ offset: Number(match[1]), text: unescape(match[2]) })
  }
  return found
}

function expectFaithful(page: NormalizedPage, markup: string) {
  const pieces = marked(markup)
  expect(pieces.length).toBeGreaterThan(0)
  for (const piece of pieces) {
    expect(page.text.slice(piece.offset, piece.offset + piece.text.length)).toBe(piece.text)
  }
}

describe("the offsets viewers draw for search", () => {
  it("are faithful in a text file, gaps included", () => {
    const text = "Line one: John Smith\n\n  indented <b>&amp; escaped</b>\nlast"
    const page = extractText("t", new Uint8Array(Buffer.from(text, "utf8"))).document.pages[0]
    expectFaithful(page, renderToStaticMarkup(<TextViewer page={page} zoom={1} />))
  })

  it("are faithful in every part of a message", () => {
    for (const source of [mixedEml(), nestedEml(), richHtmlEml()]) {
      for (const page of extractEml("e", bytesOf(source)).document.pages) {
        expectFaithful(page, renderToStaticMarkup(<EmlViewer page={page} zoom={1} />))
      }
    }
  })
})

describe("redactions in a browser that cannot paint characters", () => {
  // Without the CSS Custom Highlight API nothing is painted by character, so
  // the span a redaction falls in is styled instead: coarse, but visible.
  const text = "Staff EMP-10007\nJane Doe\nnothing here"
  const page = extractText("t", new Uint8Array(Buffer.from(text, "utf8")))
    .document.pages[0]
  const at = (value: string, status: Redaction["status"], id = value) =>
    ({
      id,
      documentId: "t",
      type: "text",
      source: "user",
      category: "other",
      status,
      page: 1,
      start: text.indexOf(value),
      end: text.indexOf(value) + value.length,
    }) satisfies Redaction
  const redactions = [
    at("EMP-10007", "accepted"),
    at("Doe", "suggested"),
    at("nothing", "rejected"),
  ]

  function drawn(selectedId: string | null = null): string {
    return renderToStaticMarkup(
      <TextViewer
        page={page}
        zoom={1}
        renderSpan={(spanId, children) => {
          const span = page.spans.find((candidate) => candidate.id === spanId)
          return (
            <span
              key={spanId}
              className={coarseRedactionClass(span, redactions, selectedId)}
            >
              {children}
            </span>
          )
        }}
      />
    )
  }

  it("blacks out an accepted redaction's span and flags a suggested one", () => {
    const markup = drawn()
    expect(markup).toMatch(/class="bg-black[^"]*"><span[^>]*>Staff EMP-10007</)
    expect(markup).toMatch(/class="bg-red-soft[^"]*"><span[^>]*>Jane Doe</)
    expect(markup).toMatch(/<span><span[^>]*>nothing here</)
  })

  it("outlines the selected one", () => {
    expect(coarseRedactionClass(page.spans[1], redactions, "Doe")).toContain(
      "outline-primary"
    )
    expect(coarseRedactionClass(page.spans[1], redactions, null)).not.toContain(
      "outline-primary"
    )
  })
})
