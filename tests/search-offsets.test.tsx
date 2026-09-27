import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { EmlViewer } from "@/components/document-viewer/eml-viewer"
import { TextViewer } from "@/components/document-viewer/text-viewer"
import { extractEml } from "@/lib/documents/eml/extract"
import { extractText } from "@/lib/documents/text/extract"
import type { NormalizedPage } from "@/types/document"

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
