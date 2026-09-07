import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { EmlViewer } from "@/components/document-viewer/eml-viewer"
import { extractEml } from "@/lib/documents/eml/extract"
import { sectionsOf } from "@/lib/documents/eml/markdown"
import type { NormalizedPage, PageSection } from "@/types/document"
import type { Redaction } from "@/types/redaction"

import {
  bytesOf,
  EML,
  mixedEml,
  nestedEml,
  richHtmlEml,
  simpleEml,
} from "./eml-fixtures"

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

/** Whether the section's body was rendered open. */
function isOpen(markup: string, section: PageSection): boolean {
  const escaped = section.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const found = new RegExp(`id="section-${escaped}"([^>]*)>`).exec(markup)
  if (!found) throw new Error(`${section.id} was not rendered`)
  return !found[1].includes("hidden")
}

function sectionOf(page: NormalizedPage, kind: PageSection["kind"]): PageSection {
  const section = sectionsOf(page).find((candidate) => candidate.kind === kind)
  if (!section) throw new Error(`no ${kind} section`)
  return section
}

/** One redaction covering the whole of a section, in whatever state. */
function covering(
  section: PageSection,
  status: Redaction["status"]
): Redaction {
  return {
    id: `r-${section.id}-${status}`,
    documentId: "doc",
    type: "text",
    source: "ai",
    category: "person",
    status,
    page: 1,
    text: "x",
    start: section.start,
    end: section.end,
  }
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

describe("folding the parts of a message", () => {
  it("opens the HTML body and folds the plain alternative it duplicates", () => {
    const page = pageOf(mixedEml())
    const markup = render(page)

    expect(isOpen(markup, sectionOf(page, "headers"))).toBe(true)
    expect(isOpen(markup, sectionOf(page, "html"))).toBe(true)
    // The same message written twice; reading both is reading it twice.
    expect(isOpen(markup, sectionOf(page, "text"))).toBe(false)
    expect(isOpen(markup, sectionOf(page, "attachments"))).toBe(false)
  })

  it("opens the plain body when that is the only body there is", () => {
    const page = pageOf(simpleEml())
    const markup = render(page)

    expect(isOpen(markup, sectionOf(page, "text"))).toBe(true)
  })

  it("names every section and lets each one be folded", () => {
    const markup = render(pageOf(mixedEml()))

    for (const label of ["Headers", "text/plain", "text/html", "Attachments"]) {
      expect(markup).toContain(label)
    }
    // Each header is a real control, not a caption.
    expect(markup.match(/aria-expanded=/g)).toHaveLength(4)
  })

  it("opens a folded section that still holds unreviewed suggestions", () => {
    const page = pageOf(mixedEml())
    const plain = sectionOf(page, "text")

    const markup = renderToStaticMarkup(
      <EmlViewer page={page} zoom={1} redactions={[covering(plain, "suggested")]} />
    )

    // It would have been folded — the HTML body is the active one — and the
    // default is overruled. A default this code chose must never be the reason
    // something went unread.
    expect(isOpen(markup, plain)).toBe(true)
    expect(markup).toContain("1 to review")
  })

  it("leaves a section folded when everything in it has been decided", () => {
    const page = pageOf(mixedEml())
    const plain = sectionOf(page, "text")

    const markup = renderToStaticMarkup(
      <EmlViewer page={page} zoom={1} redactions={[covering(plain, "accepted")]} />
    )

    expect(isOpen(markup, plain)).toBe(false)
    // Folded, but never silent about what is inside it.
    expect(markup).toContain("1 redacted")
    expect(markup).not.toContain("to review")
  })

  it("steps a forwarded message in, so a thread reads as the nest it is", () => {
    const markup = render(pageOf(nestedEml()))

    expect(markup).toContain("Forwarded message")
    expect(markup).toContain("margin-left:16px")
  })
})

describe("the page rail's preview", () => {
  it("draws the body alone, with no chrome and nothing folded", () => {
    const page = pageOf(mixedEml())
    const markup = renderToStaticMarkup(
      <EmlViewer page={page} zoom={0.2} variant="preview" />
    )

    // A rail of tiles all showing the same From: block says nothing about
    // which page you are looking for.
    expect(markup).not.toContain("Subject:")
    expect(markup).not.toContain("aria-expanded")
    expect(markup).not.toContain("Attachments")
    expect(markup).toContain("scale(0.2)")
  })

  it("falls back to the plain body when the message has no HTML part", () => {
    const markup = renderToStaticMarkup(
      <EmlViewer page={pageOf(simpleEml())} zoom={0.2} variant="preview" />
    )

    // Rendering nothing here would put back the column of blank rectangles the
    // rail exists to avoid.
    expect(readable(markup)).toContain(EML.phone)
    expect(markup).not.toContain("Subject:")
  })
})
