import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { HushMarkdown } from "@/components/assistant/hush-markdown"

/**
 * Hush's replies, rendered. A reply can quote the document, and the document
 * is untrusted, so what matters is what the markup must never contain: an
 * attribute the browser would fetch, or HTML the model passed through.
 */

function render(markdown: string, streaming = false): string {
  return renderToStaticMarkup(
    <HushMarkdown streaming={streaming}>{markdown}</HushMarkdown>
  )
}

describe("Hush's replies", () => {
  it("renders Markdown: emphasis, lists, code and tables", () => {
    const markup = render(
      [
        "Found **3** matches of `EMP-\\d{5}`:",
        "",
        "- page 1",
        "- page 4",
        "",
        "| Page | Count |",
        "| --- | --- |",
        "| 1 | 2 |",
      ].join("\n")
    )
    expect(markup).toContain(`data-streamdown="strong"`)
    expect(markup).toContain("EMP-\\d{5}")
    expect(markup).toContain("<li")
    expect(markup).toContain("<table")
  })

  it("never renders a link, an image or raw HTML the browser would fetch", () => {
    const markup = render(
      [
        "See [the portal](https://tracker.example/pixel?id=1).",
        "",
        "![logo](https://tracker.example/pixel.png)",
        "",
        '<img src="https://tracker.example/x.gif"> <a href="https://evil.example">x</a>',
      ].join("\n")
    )
    expect(markup).not.toMatch(/\shref=/)
    expect(markup).not.toMatch(/\ssrc=/)
    expect(markup).not.toContain("tracker.example")
    expect(markup).toContain("the portal")
    expect(markup).toContain("[image: logo]")
  })

  it("renders a half-finished reply while it streams", () => {
    const markup = render("Found **3 matc", true)
    expect(markup).toContain("Found")
    expect(markup).not.toContain("**")
  })
})
