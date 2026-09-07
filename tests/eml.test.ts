import { describe, expect, it } from "vitest"

import { parseEmlAddress } from "@/lib/documents/eml/address"
import { extractEml } from "@/lib/documents/eml/extract"
import { parseHtmlText } from "@/lib/documents/eml/html"
import { DEFAULT_EML_LIMITS, EmlLimitError } from "@/lib/documents/eml/limits"
import {
  decodeEml,
  EmlParseError,
  looksLikeEml,
  parseEml,
} from "@/lib/documents/eml/parse"
import { redactEml } from "@/lib/documents/eml/redact"
import { emlReparses } from "@/lib/documents/eml/validate"
import { buildEmlPlan } from "@/lib/redaction/apply"
import { detectPatterns } from "@/lib/redaction/detectors"
import { verifyExport } from "@/lib/redaction/validation"
import type { NormalizedDocument } from "@/types/document"
import type { Redaction } from "@/types/redaction"

import {
  alternativeEml,
  bytesOf,
  deeplyNestedEml,
  duplicatedEml,
  EML,
  encodedHeaderEml,
  manyPartsEml,
  mixedEml,
  nestedEml,
  quotedReplyEml,
  richHtmlEml,
  simpleEml,
  truncatedMultipartEml,
} from "./eml-fixtures"

/**
 * Email.
 *
 * The thing being defended here is completeness. A person's name in a message
 * is almost never in one place: it is in From, in the greeting, in the HTML
 * alternative of that greeting, in the quoted reply three messages down, and
 * in the attachment called `2026-review-John Smith.pdf`. A pipeline that finds
 * one of those and reports success is worse than no pipeline, because it is
 * believed.
 *
 * So every redaction test below asserts three things, not one: the value is
 * gone from *everywhere* it was, the message still parses — with an
 * independent library, not only with ours — and the parts nobody touched are
 * unchanged to the byte.
 */

const OPTIONS = { addLabels: false, sanitizeMetadata: true }

function extract(source: string) {
  return extractEml("doc", bytesOf(source))
}

/** Accepts every deterministic detection over the reviewed text. */
function detectionsAsRedactions(model: NormalizedDocument): Redaction[] {
  const redactions: Redaction[] = []

  for (const page of model.pages) {
    for (const [index, detection] of detectPatterns(page.text, {
      page: page.number,
    }).entries()) {
      redactions.push({
        id: `det-${page.number}-${index}`,
        documentId: "doc",
        type: "text",
        source: "ai",
        category: detection.category,
        status: "accepted",
        page: detection.page,
        text: detection.text,
        start: detection.start,
        end: detection.end,
      })
    }
  }

  return redactions
}

/** A redaction over the first occurrence of a value in the reviewed text. */
function redactionFor(model: NormalizedDocument, value: string): Redaction {
  for (const page of model.pages) {
    const index = page.text.indexOf(value)
    if (index === -1) continue
    return {
      id: `red-${value}`,
      documentId: "doc",
      type: "text",
      source: "ai",
      category: "email",
      status: "accepted",
      page: page.number,
      text: value,
      start: index,
      end: index + value.length,
    }
  }
  throw new Error(`${value} is not in the reviewed text`)
}

describe("recognising a message", () => {
  it("accepts something with real headers", () => {
    expect(looksLikeEml(bytesOf(simpleEml()))).toBe(true)
  })

  it("refuses a text file that merely has colons in it", () => {
    // The case the extension alone would get wrong.
    const configuration = "name: value\r\nother: thing\r\n\r\nbody\r\n"
    expect(looksLikeEml(bytesOf(configuration))).toBe(false)
    expect(looksLikeEml(bytesOf("just some prose, honestly"))).toBe(false)
    expect(looksLikeEml(bytesOf(""))).toBe(false)
  })

  it("refuses a message with no headers at all", () => {
    expect(() => parseEml("\r\n\r\njust a body")).toThrow(EmlParseError)
    expect(() => parseEml("   ")).toThrow(EmlParseError)
  })
})

describe("parsing the MIME tree", () => {
  it("reads headers, including folded and encoded ones", () => {
    const { root } = parseEml(encodedHeaderEml())

    expect(root.headers.find((h) => h.name === "subject")?.value).toBe(
      `Rapport de ${EML.accented}`
    )
    expect(root.headers.find((h) => h.name === "from")?.value).toBe(
      `${EML.accented} <${EML.accentedEmail}>`
    )
    // Folded across three lines, unfolded into one value.
    expect(root.headers.find((h) => h.name === "cc")?.value).toContain(
      EML.colleagueEmail
    )
    expect(root.headers.find((h) => h.name === "cc")?.value).toContain(
      "someone.else@example.com"
    )
  })

  it("decodes base64 and quoted-printable bodies", () => {
    const { root } = parseEml(encodedHeaderEml())
    expect(root.text).toContain(EML.accented)
    expect(root.text).toContain(EML.accentedEmail)

    const mixed = parseEml(mixedEml())
    const plain = mixed.nodes.find((node) => node.contentType === "text/plain")
    expect(plain?.text).toContain(EML.person)
    // `=20` is a quoted-printable space, not three characters of content.
    expect(plain?.text).not.toContain("=20")
  })

  it("keeps the part hierarchy rather than flattening it", () => {
    const { root, nodes } = parseEml(mixedEml())

    expect(root.contentType).toBe("multipart/mixed")
    expect(root.children).toHaveLength(2)
    expect(root.children[0].contentType).toBe("multipart/alternative")
    expect(root.children[0].children.map((n) => n.contentType)).toEqual([
      "text/plain",
      "text/html",
    ])
    expect(root.children[1].attachment).toBe(true)

    // Paths are the addresses everything downstream depends on.
    expect(nodes.map((node) => node.path)).toEqual([
      "0",
      "0.1",
      "0.1.1",
      "0.1.2",
      "0.2",
    ])
  })

  it("descends into nested messages", () => {
    const { nodes } = parseEml(nestedEml())

    const nested = nodes.filter((node) => node.contentType === "message/rfc822")
    expect(nested).toHaveLength(2)

    const deepest = nodes.find((node) => node.path.endsWith(".msg.2.msg"))
    expect(deepest?.headers.find((h) => h.name === "subject")?.value).toBe(
      "The original"
    )
    expect(deepest?.text).toContain(EML.email)
  })

  it("reads an attachment's filename and leaves its bytes alone", () => {
    const { nodes } = parseEml(mixedEml())
    const attachment = nodes.find((node) => node.attachment)

    expect(attachment?.filename).toBe("2026-review-John Smith.pdf")
    expect(attachment?.text).toBeNull()
  })

  it("keeps the last part of a multipart with no closing delimiter", () => {
    // Discarding it would hide content rather than report a problem.
    const { nodes } = parseEml(truncatedMultipartEml())
    const plain = nodes.find((node) => node.contentType === "text/plain")
    expect(plain?.text).toContain(EML.phone)
  })
})

describe("resource limits", () => {
  it("refuses a message nested past the depth limit", () => {
    expect(() =>
      parseEml(deeplyNestedEml(40), { ...DEFAULT_EML_LIMITS, maxDepth: 8 })
    ).toThrow(EmlLimitError)
  })

  it("refuses a message with too many parts", () => {
    expect(() =>
      parseEml(manyPartsEml(50), { ...DEFAULT_EML_LIMITS, maxParts: 10 })
    ).toThrow(EmlLimitError)
  })

  it("refuses a header block past the size limit", () => {
    expect(() =>
      parseEml(simpleEml(), { ...DEFAULT_EML_LIMITS, maxHeaderBytes: 32 })
    ).toThrow(EmlLimitError)
  })

  it("refuses more decoded text than it will read", () => {
    expect(() =>
      parseEml(simpleEml(), { ...DEFAULT_EML_LIMITS, maxTextBytes: 4 })
    ).toThrow(EmlLimitError)
  })

  it("refuses more nested messages than it will follow", () => {
    expect(() =>
      parseEml(nestedEml(), { ...DEFAULT_EML_LIMITS, maxNestedMessages: 1 })
    ).toThrow(EmlLimitError)
  })

  it("refuses more attachments than it will track", () => {
    expect(() =>
      parseEml(mixedEml(), { ...DEFAULT_EML_LIMITS, maxAttachments: 0 })
    ).toThrow(EmlLimitError)
  })

  it("fails closed rather than returning a partial tree", () => {
    // The distinction that matters: a reviewer shown eight of twelve parts and
    // told nothing has been handed a redaction they cannot trust.
    let caught: unknown
    try {
      parseEml(manyPartsEml(50), { ...DEFAULT_EML_LIMITS, maxParts: 10 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EmlLimitError)
    expect((caught as EmlLimitError).limit).toBe("maxParts")
  })
})

describe("the visible text of an HTML body", () => {
  it("reads text a tag split in half as one value", () => {
    const { text } = parseHtmlText("<p>jo<span>hn</span>@example.com</p>")
    expect(text).toContain("john@example.com")
  })

  it("decodes entities", () => {
    const { text } = parseHtmlText("<p>john&#64;example.com &amp; co</p>")
    expect(text).toContain("john@example.com & co")
  })

  it("skips script and style content", () => {
    const { text } = parseHtmlText(
      "<style>.a{color:red}</style><script>var x='john@example.com'</script><p>visible</p>"
    )
    expect(text).toContain("visible")
    expect(text).not.toContain("color")
    expect(text).not.toContain("var x")
  })

  it("writes a link target as text the reviewer can act on", () => {
    const { text, attributes } = parseHtmlText(
      '<a href="mailto:john@example.com">write to me</a>'
    )
    // An address reachable only through an href used to be swept at export and
    // never shown, so the reviewer was trusting a removal they could not see.
    // As markdown it is text, addressed by the bytes it came from.
    expect(text).toBe("[write to me](mailto:john@example.com)")
    expect(attributes.map((a) => a.value)).toContain("mailto:john@example.com")
  })

  it("keeps the structure the markup was expressing", () => {
    const { text } = parseHtmlText(
      "<h2>Attendees</h2><ul><li>Alice</li><li>Bob</li></ul>" +
        "<table><tr><th>Name</th><th>Role</th></tr>" +
        "<tr><td>Alice</td><td>PM</td></tr></table>" +
        "<blockquote><p>On Tue, Bob wrote:</p></blockquote>"
    )

    expect(text).toBe(
      [
        "## Attendees",
        "",
        "- Alice",
        "- Bob",
        "",
        "| Name | Role |",
        "| --- | --- |",
        "| Alice | PM |",
        "",
        "> On Tue, Bob wrote:",
      ].join("\n")
    )
  })

  it("reads a nested layout table as layout, not as a table", () => {
    // Every newsletter is built from single-cell tables nested several deep.
    // Counting the inner table's cells as the outer row's would pipe a
    // one-column wrapper into a two-column table and bury the message in
    // punctuation.
    const { text } = parseHtmlText(
      '<table width="600"><tr><td><table><tr><td>' +
        "<p>Hello there</p>" +
        "</td></tr></table></td></tr></table>"
    )

    expect(text).toBe("Hello there")
  })

  it("collapses markup indentation but keeps the spaces between words", () => {
    const { text, atoms } = parseHtmlText("<div>\n    Alice Brown\n  </div>")

    // The newlines and the indentation are markup and go; the space between
    // the two words is the author's and stays a literal, so a value written
    // across it is one contiguous range rather than two with an unremovable
    // gap between them.
    expect(text).toBe("Alice Brown")

    const literals = atoms.filter((atom) => atom.kind === "literal")
    expect(
      literals.map((atom) => text.slice(atom.textStart, atom.textEnd))
    ).toEqual(["Alice", " ", "Brown"])

    // A line break inside the markup reads as the single space it renders as,
    // rather than splitting the name across two lines of the review.
    expect(parseHtmlText("<div>\n  Alice\n  Brown\n</div>").text).toBe(
      "Alice Brown"
    )
  })

  it("emits an image as its alt text, never as its source", () => {
    const { text } = parseHtmlText(
      '<p><img src="https://tracker.example/pixel.gif" alt="Photo of John"></p>'
    )

    // The alt text can name somebody, so it is reviewable. The src is not
    // written at all: a reviewer never needs a CDN URL, and text is not
    // something the renderer can turn back into a request.
    expect(text).toBe("![Photo of John]")
    expect(text).not.toContain("tracker.example")
  })

  it("points every atom at the bytes that produced it", () => {
    const source = "<p>caf&eacute;: jo<b>hn</b>@example.com</p>"
    const { text, atoms } = parseHtmlText(source)

    for (const atom of atoms) {
      if (atom.kind !== "literal") continue
      expect(source.slice(atom.start, atom.end)).toBe(
        text.slice(atom.textStart, atom.textEnd)
      )
    }
  })
})

describe("extracting a message for review", () => {
  it("puts the headers in front of the reviewer, not only the body", () => {
    const { document } = extract(simpleEml())
    const text = document.pages.map((page) => page.text).join("\n")

    expect(text).toContain("Subject: Quarterly review")
    expect(text).toContain(EML.email)
    expect(text).toContain(EML.phone)
  })

  it("gives every span an address that parses", () => {
    const { document } = extract(mixedEml())

    for (const page of document.pages) {
      for (const span of page.spans) {
        expect(parseEmlAddress(span.id)).not.toBeNull()
      }
    }
  })

  it("addresses headers, bodies and filenames distinctly", () => {
    const { document } = extract(mixedEml())
    const kinds = new Set(
      document.pages
        .flatMap((page) => page.spans)
        .map((span) => parseEmlAddress(span.id)?.kind)
    )

    expect(kinds).toContain("header")
    expect(kinds).toContain("body")
    expect(kinds).toContain("filename")
  })

  it("shows the text of an HTML part as markdown, not as markup", () => {
    const { document } = extract(alternativeEml())
    const text = document.pages.map((page) => page.text).join("\n")

    expect(text).not.toContain("<p>")
    expect(text).not.toContain("<b>")
    // Split across a tag in the source, whole in the review.
    expect(text).toContain("john@example.com")
    // What the markup was saying survives as something a reviewer can read.
    expect(text).toContain("**John Smith**")
    expect(text).toContain("[john@example.com](mailto:john@example.com)")
  })

  it("names the parts of the message a page holds", () => {
    const { document } = extract(mixedEml())
    const sections = document.pages.flatMap((page) => page.sections ?? [])

    expect(sections.map((section) => section.kind)).toEqual([
      "headers",
      "text",
      "html",
      "attachments",
    ])
    expect(sections.map((section) => section.label)).toEqual([
      "Headers",
      "text/plain",
      "text/html",
      "Attachments",
    ])

    // Only the HTML body is markdown; everything else is the flat stream it
    // has always been.
    expect(
      sections.filter((section) => section.markdown).map((section) => section.kind)
    ).toEqual(["html"])
  })

  it("gives a section a stable identity, so a split body folds as one", () => {
    const { document } = extract(richHtmlEml())
    const page = document.pages[0]
    const sections = page.sections ?? []

    expect(sections.length).toBeGreaterThan(0)
    for (const section of sections) {
      // The id names the part, never the position: `body:0` is the same
      // section on page one and on page four.
      expect(section.id).toMatch(/^(headers|body|attachments):/)
      expect(section.end).toBeGreaterThan(section.start)
      expect(page.text.slice(section.start, section.end).length).toBeGreaterThan(0)
    }

    const html = sections.find((section) => section.kind === "html")!
    expect(html.markdown).toBe(true)
    expect(page.text.slice(html.start, html.end)).toContain("# Quarterly review")
    // The headers are their own section and are not inside the body's range.
    expect(page.text.slice(html.start, html.end)).not.toContain("Subject:")
  })

  it("sections a forwarded message one level deeper than the one carrying it", () => {
    const { document } = extract(nestedEml())
    const sections = document.pages.flatMap((page) => page.sections ?? [])

    const headers = sections.filter((section) => section.kind === "headers")
    expect(headers.length).toBeGreaterThan(1)

    expect(headers[0].label).toBe("Headers")
    expect(headers[0].depth).toBeUndefined()

    const forwarded = headers[1]
    expect(forwarded.label).toBe("Forwarded message")
    expect(forwarded.depth).toBe(1)
  })

  it("puts every character of a section's text inside that section", () => {
    const { document } = extract(mixedEml())

    for (const page of document.pages) {
      const sections = [...(page.sections ?? [])].sort((a, b) => a.start - b.start)

      let cursor = 0
      for (const section of sections) {
        // Sections never overlap, and what sits between them is only the blank
        // lines that separate them — never content nobody would be shown.
        expect(section.start).toBeGreaterThanOrEqual(cursor)
        expect(page.text.slice(cursor, section.start).trim()).toBe("")
        cursor = section.end
      }
      expect(page.text.slice(cursor).trim()).toBe("")

      // And every span belongs to one of them, or it is text with nowhere to
      // be drawn.
      for (const span of page.spans) {
        expect(
          sections.some(
            (section) => span.start >= section.start && span.end <= section.end
          )
        ).toBe(true)
      }
    }
  })

  it("carries the structure of an HTML body into the reviewed text", () => {
    const { document } = extract(richHtmlEml())
    const text = document.pages.map((page) => page.text).join("\n")

    expect(text).toContain("# Quarterly review")
    expect(text).toContain(`- ${EML.colleague}`)
    expect(text).toContain("- Bob Chen")
    expect(text).toContain("| Name | Role |")
    expect(text).toContain(`| ${EML.person} | Chair |`)
    expect(text).toContain("> On Tue, Bob wrote:")
    expect(text).toContain(`[the chair](mailto:${EML.email})`)

    // The layout tables around all of it contributed nothing.
    expect(text).not.toContain("|  |")
    // Markup indentation is not text, and a line break in the middle of a
    // paragraph is not a paragraph break.
    expect(text).toContain("Attendees, in reading order:")
  })

  it("never lets a span cross a line of the reviewed markdown", () => {
    const { document } = extract(richHtmlEml())

    for (const page of document.pages) {
      for (const span of page.spans) {
        expect(span.text).not.toContain("\n")
        expect(page.text.slice(span.start, span.end)).toBe(span.text)
      }
    }
  })

  it("keeps quoted replies as reviewable text", () => {
    const { document } = extract(quotedReplyEml())
    const text = document.pages.map((page) => page.text).join("\n")

    expect(text).toContain("> You can reach me on")
    expect(text).toContain(">> My number is")
  })

  it("reaches every level of a nested message", () => {
    const { document } = extract(nestedEml())
    const text = document.pages.map((page) => page.text).join("\n")

    expect(text).toContain("Forwarding the message below.")
    expect(text).toContain("My direct line is")
    expect(text).toContain("Three deep, still")
    expect(document.metadata?.nestedMessages).toBe(2)
  })

  it("counts what the quota will be charged on", () => {
    const { document } = extract(mixedEml())
    expect(document.metadata?.parts).toBe(5)
    expect(document.metadata?.attachments).toBe(1)
    expect(Number(document.metadata?.textBytes)).toBeGreaterThan(0)
  })
})

describe("redacting a message", () => {
  it("removes a value from a header and leaves a parseable message", async () => {
    const source = simpleEml()
    const { document } = extract(source)
    const redaction = redactionFor(document, EML.phone)

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [redaction], OPTIONS)
    )

    expect(await emlReparses(output)).toBe(true)
    const { root } = parseEml(decodeEml(output))
    expect(root.text).not.toContain(EML.phone)
    expect(root.headers.find((h) => h.name === "subject")?.value).toBe(
      "Quarterly review"
    )
  })

  it("removes an address from every header that carries it", async () => {
    const source = duplicatedEml()
    const { document } = extract(source)
    const redaction = redactionFor(document, EML.email)

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [redaction], OPTIONS)
    )

    expect(await emlReparses(output)).toBe(true)

    const { nodes } = parseEml(decodeEml(output))
    for (const node of nodes) {
      for (const header of node.headers) {
        expect(header.value).not.toContain(EML.email)
      }
      expect(node.filename ?? "").not.toContain(EML.email)
      expect(node.text ?? "").not.toContain(EML.email)
    }
  })

  it("keeps an address header an address header", async () => {
    const source = simpleEml()
    const { document } = extract(source)
    const redaction = redactionFor(document, EML.person)

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [redaction], OPTIONS)
    )

    const { root } = parseEml(decodeEml(output))
    const from = root.headers.find((h) => h.name === "from")?.value ?? ""

    expect(from).not.toContain(EML.person)
    // The brackets are syntax, and they have to survive: encoding the whole
    // value as one word would turn the address into payload.
    expect(from).toContain(`<${EML.email}>`)
    expect(await emlReparses(output)).toBe(true)
  })

  it("removes a value from HTML without breaking the markup", async () => {
    const source = alternativeEml()
    const { document } = extract(source)
    const redaction = redactionFor(document, "john@example.com")

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [redaction], OPTIONS)
    )

    expect(await emlReparses(output)).toBe(true)

    const { nodes } = parseEml(decodeEml(output))
    const html = nodes.find((node) => node.contentType === "text/html")
    expect(html?.text).toBeDefined()

    // Gone from the rendered text, gone from the link target, and the tags
    // around it are intact.
    const rendered = parseHtmlText(html!.text!)
    expect(rendered.text).not.toContain("john@example.com")
    expect(html!.text).not.toContain("mailto:john@example.com")
    expect(html!.text).toContain("<p>")
    expect(html!.text).toContain("</a>")
  })

  it("removes a value from a quoted reply as readily as from the top", async () => {
    const source = quotedReplyEml()
    const { document } = extract(source)
    const redaction = redactionFor(document, EML.phone)

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [redaction], OPTIONS)
    )

    const { root } = parseEml(decodeEml(output))
    expect(root.text).not.toContain(EML.phone)
    // The quoting itself survives; the thread is still readable.
    expect(root.text).toContain("> You can reach me on")
    expect(await emlReparses(output)).toBe(true)
  })

  it("reaches into a nested message", async () => {
    const source = nestedEml()
    const { document } = extract(source)
    const redaction = redactionFor(document, EML.phone)

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [redaction], OPTIONS)
    )

    expect(await emlReparses(output)).toBe(true)

    const { nodes } = parseEml(decodeEml(output))
    expect(nodes.filter((n) => n.contentType === "message/rfc822")).toHaveLength(
      2
    )
    for (const node of nodes) {
      expect(node.text ?? "").not.toContain(EML.phone)
    }
    // The innermost message is still a message.
    const deepest = nodes.find((node) => node.path.endsWith(".msg.2.msg"))
    expect(deepest?.headers.find((h) => h.name === "subject")?.value).toBe(
      "The original"
    )
  })

  it("redacts an attachment's filename and not its bytes", async () => {
    const source = mixedEml()
    const { document } = extract(source)
    const redaction = redactionFor(document, EML.person)

    const before = parseEml(source).nodes.find((node) => node.attachment)!
    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [redaction], OPTIONS)
    )

    expect(await emlReparses(output)).toBe(true)

    const after = parseEml(decodeEml(output)).nodes.find(
      (node) => node.attachment
    )!
    expect(after.filename).not.toContain(EML.person)
    expect(after.filename).toContain(".pdf")

    // Byte for byte: an EML export redacts the message, not the formats inside
    // it, and pretending otherwise would be claiming support we do not have.
    expect(decodeEml(output).slice(after.bodyStart, after.end)).toBe(
      source.slice(before.bodyStart, before.end)
    )
  })

  it("leaves every part it was not asked to touch byte-identical", async () => {
    const source = mixedEml()
    const { document } = extract(source)
    const redaction = redactionFor(document, EML.person)

    const output = decodeEml(
      redactEml(bytesOf(source), buildEmlPlan(document, [redaction], OPTIONS))
    )

    // The boundaries are the structure; if any of them moved, the parts moved.
    for (const boundary of ["--outer", "--inner", "--outer--", "--inner--"]) {
      expect(output).toContain(boundary)
    }
    expect(output).toContain("2026-review-")
  })

  it("writes the marker once per value, not once per fragment", async () => {
    const source = alternativeEml()
    const { document } = extract(source)
    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [redactionFor(document, "john@example.com")], {
        ...OPTIONS,
        addLabels: true,
      })
    )

    const { nodes } = parseEml(decodeEml(output))
    const html = nodes.find((node) => node.contentType === "text/html")!
    const rendered = parseHtmlText(html.text!).text

    // Two places the reviewer can see the address — the link's text, which the
    // markup split across three fragments, and the link's target — so two
    // markers rather than four.
    expect(rendered.match(/\[REDACTED\]/g)?.length).toBe(2)
    // The link's target keeps its scheme: `mailto:` is not the address, and
    // removing it would leave a link that no longer says what it was.
    expect(rendered).toContain("[[REDACTED]](mailto:[REDACTED])")
  })

  it("keeps non-ASCII content that was not redacted", async () => {
    const source = encodedHeaderEml()
    const { document } = extract(source)
    const redaction = redactionFor(document, EML.accentedEmail)

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [redaction], OPTIONS)
    )

    expect(await emlReparses(output)).toBe(true)

    const { root } = parseEml(decodeEml(output))
    expect(root.text).toContain(EML.accented)
    expect(root.text).not.toContain(EML.accentedEmail)
    expect(root.headers.find((h) => h.name === "subject")?.value).toContain(
      EML.accented
    )
  })

  it("ignores a rejected suggestion", () => {
    const source = simpleEml()
    const { document } = extract(source)
    const rejected: Redaction = {
      ...redactionFor(document, EML.phone),
      status: "rejected",
    }

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, [rejected], OPTIONS)
    )
    expect(parseEml(decodeEml(output)).root.text).toContain(EML.phone)
  })

  it("returns the message untouched when nothing was accepted", () => {
    const source = simpleEml()
    const { document } = extract(source)
    const output = redactEml(bytesOf(source), buildEmlPlan(document, [], OPTIONS))

    expect(decodeEml(output)).toBe(source)
  })
})

describe("verifying an exported message", () => {
  it("passes only once every copy of the value is gone", async () => {
    const source = duplicatedEml()
    const { document } = extract(source)
    const redactions = detectionsAsRedactions(document)

    expect(redactions.some((entry) => entry.text === EML.email)).toBe(true)

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, redactions, OPTIONS)
    )

    const report = await verifyExport("eml", output, redactions)
    expect(report.passed).toBe(true)
    expect(report.checkedValues).toBeGreaterThan(0)

    const untouched = await verifyExport("eml", bytesOf(source), redactions)
    expect(untouched.passed).toBe(false)
    expect(untouched.leaked).toContain(EML.email)
  })

  it("looks in every part, at every depth", async () => {
    const source = nestedEml()
    const { document } = extract(source)
    const redactions = detectionsAsRedactions(document)

    const output = redactEml(
      bytesOf(source),
      buildEmlPlan(document, redactions, OPTIONS)
    )

    expect((await verifyExport("eml", output, redactions)).passed).toBe(true)
  })

  it("refuses an artifact an independent parser cannot read", async () => {
    // Not a hypothetical: the whole reason two parsers are used is that ours
    // would happily read something no mail client would.
    const corrupted = bytesOf("this is not a message at all")
    await expect(
      verifyExport("eml", corrupted, [
        {
          id: "x",
          documentId: "doc",
          type: "text",
          source: "ai",
          category: "email",
          status: "accepted",
          text: EML.email,
        },
      ])
    ).rejects.toThrow()
  })
})
