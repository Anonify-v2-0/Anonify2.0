import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { EmlViewer } from "@/components/document-viewer/eml-viewer"
import { extractEml } from "@/lib/documents/eml/extract"
import type { NormalizedPage } from "@/types/document"

import { bytesOf, EML, richHtmlEml, simpleEml } from "./eml-fixtures"

/**
 * Drawing a message.
 *
 * Rendered to static markup rather than into a DOM: what matters here is the
 * shape of the tree — that a table came out as a table and a quote as a quote —
 * and, above all, what is *not* in it. A message is untrusted input, and the
 * one thing this canvas must never do is hand any of it back to the browser as
 * something to fetch.
 */

function pageOf(source: string): NormalizedPage {
  return extractEml("doc", bytesOf(source)).document.pages[0]
}

function render(page: NormalizedPage): string {
  return renderToStaticMarkup(<EmlViewer page={page} zoom={1} />)
}

/** What a reader would see, with the elements around it taken away. */
function readable(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

describe("drawing an email page", () => {
  it("draws an HTML body as the document it was written as", () => {
    const markup = render(pageOf(richHtmlEml()))

    expect(markup).toContain('aria-level="1"')
    expect(markup).toContain("Quarterly review")

    expect(markup).toContain("<ul")
    expect(markup).toContain(`<li class="my-1">`)
    expect(markup).toContain(EML.colleague)
    expect(markup).toContain("Bob Chen")

    expect(markup).toContain("<table")
    expect(markup).toContain("<th")
    expect(markup).toContain("Role")
    expect(markup).toContain(EML.person)

    expect(markup).toContain("<blockquote")
    expect(markup).toContain("On Tue, Bob wrote:")

    // None of the markdown punctuation survives as text on the page.
    expect(markup).not.toContain("| ---")
    expect(markup).not.toContain("&gt; On Tue")
  })

  it("never puts anything from the message where a browser would fetch it", () => {
    const markup = render(pageOf(richHtmlEml()))

    // The whole safety argument in one assertion: the message became text long
    // before it got here, and text is not something the renderer can turn back
    // into a request.
    expect(markup).not.toContain("href=")
    expect(markup).not.toContain("src=")
    expect(markup).not.toContain("<script")
    expect(markup).not.toContain("onerror")

    // The link's target is still on the page — as text a reviewer can act on.
    expect(markup).toContain(`mailto:${EML.email}`)
  })

  it("leaves a message with no HTML in the stream it has always been", () => {
    const markup = render(pageOf(simpleEml()))

    expect(markup).toContain("pre-wrap")
    expect(markup).toContain("Subject:")
    // Nothing to draw as a document, so nothing is invented.
    expect(markup).not.toContain("<blockquote")
    expect(markup).not.toContain("<ul")
  })

  it("keeps the headers fixed-width even when a body is drawn as markdown", () => {
    const markup = render(pageOf(richHtmlEml()))

    // The header block is still the flat stream, sitting above a body that is
    // now a document. A header value is its own span, so the label and the
    // value are separate elements and only the reading order joins them.
    expect(markup).toContain("pre-wrap")
    expect(readable(markup)).toContain("Subject: Quarterly review")
    expect(readable(markup)).toContain(`From: ${EML.person} <${EML.email}>`)
  })

  it("offers every span to the canvas so a redaction can be drawn over it", () => {
    const page = pageOf(richHtmlEml())
    const seen: string[] = []

    const markup = renderToStaticMarkup(
      <EmlViewer
        page={page}
        zoom={1}
        renderSpan={(spanId, children) => {
          seen.push(spanId)
          return <mark data-redactable={spanId}>{children}</mark>
        }}
      />
    )

    // Every span on the page, in both the flat stream and the markdown, and
    // each offered exactly once — a span drawn twice is two places for the
    // accepted state to disagree.
    expect([...seen].sort()).toEqual(page.spans.map((span) => span.id).sort())
    expect(markup).toContain("data-redactable=")
  })
})
