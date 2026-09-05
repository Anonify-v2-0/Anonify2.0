import { describe, expect, it } from "vitest"

import {
  CHARS_PER_PAGE,
  extractText,
  linesOf,
  paginateText,
  parseTextAddress,
  textAddress,
} from "@/lib/documents/text/extract"
import { redactText } from "@/lib/documents/text/redact"
import { UTF8_BOM } from "@/lib/documents/delimited/parse"
import { buildTextPlan } from "@/lib/redaction/apply"
import { detectPatterns } from "@/lib/redaction/detectors"
import { verifyExport } from "@/lib/redaction/validation"
import type { Redaction } from "@/types/redaction"

import { SENSITIVE } from "./fixtures"

/**
 * Plain text.
 *
 * The property this suite exists to protect: a redaction is addressed by its
 * offset in the *source*, never by where it happened to land on an invented
 * page. Pagination is ours and we can change it; the offsets belong to the
 * file. So the tests below deliberately paginate a document into several pages
 * and then assert that the export edits exactly the right characters.
 */

const encoder = new TextEncoder()

function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

function textOf(output: Uint8Array): string {
  return new TextDecoder().decode(output)
}

const OPTIONS = { addLabels: false, sanitizeMetadata: true }

const SOURCE = [
  "Client notes",
  "",
  `Name: ${SENSITIVE.person}`,
  `Email: ${SENSITIVE.email}`,
  `Phone: ${SENSITIVE.phone}`,
  `Repeat: ${SENSITIVE.email}`,
  "Naïve café — a line with non-ASCII characters.",
  "",
].join("\n")

/** A redaction over the first occurrence of `value` on its page. */
function redactionFor(
  model: ReturnType<typeof extractText>["document"],
  value: string,
  occurrence = 0
): Redaction {
  let seen = 0
  for (const page of model.pages) {
    let index = page.text.indexOf(value)
    while (index !== -1) {
      if (seen === occurrence) {
        return {
          id: `red-${value}-${occurrence}`,
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
      seen += 1
      index = page.text.indexOf(value, index + value.length)
    }
  }
  throw new Error(`${value} does not appear ${occurrence + 1} time(s)`)
}

describe("addressing text by source offset", () => {
  it("round-trips an address", () => {
    expect(parseTextAddress(textAddress(1042))).toBe(1042)
    expect(parseTextAddress(textAddress(0))).toBe(0)
  })

  it("refuses an address it did not write", () => {
    expect(parseTextAddress("word/document.xml#p0r1")).toBeNull()
    expect(parseTextAddress("text#")).toBeNull()
    expect(parseTextAddress("text#abc")).toBeNull()
  })

  it("keeps every line's offset in the original string", () => {
    const lines = linesOf("one\ntwo\r\nthree")

    expect(lines.map((line) => line.text)).toEqual(["one", "two", "three"])
    expect(lines.map((line) => line.start)).toEqual([0, 4, 9])
    // The offsets have to be into the source, mixed line endings and all.
    expect("one\ntwo\r\nthree".slice(9)).toBe("three")
  })
})

describe("extracting plain text", () => {
  it("gives each span the offset it starts at in the file", () => {
    const { document, text } = extractText("doc", bytes(SOURCE))
    const page = document.pages[0]

    for (const span of page.spans) {
      const offset = parseTextAddress(span.id)
      expect(offset).not.toBeNull()
      expect(text.slice(offset!, offset! + span.text.length)).toBe(span.text)
    }
  })

  it("reads non-ASCII text as itself", () => {
    const { document } = extractText("doc", bytes(SOURCE))
    expect(document.pages[0].text).toContain("Naïve café — a line")
  })

  it("paginates long text deterministically, on line boundaries", () => {
    const long = Array.from(
      { length: 400 },
      (_, index) => `Line ${index} of a document with no page breaks at all.`
    ).join("\n")

    const pages = paginateText(long)
    expect(pages.length).toBeGreaterThan(1)

    // Same input, same pages: a redaction filed under page 3 must still be on
    // page 3 the next time the document is opened.
    expect(paginateText(long).map((page) => page.text)).toEqual(
      pages.map((page) => page.text)
    )

    for (const page of pages) {
      // A page may overrun by the last line it took, never by more.
      expect(page.text.length).toBeLessThan(CHARS_PER_PAGE * 2)
      // No line is split across a page boundary.
      for (const span of page.spans) {
        expect(span.text).not.toContain("\n")
      }
    }
  })

  it("keeps a line longer than a page on one page rather than cutting it", () => {
    const single = "x".repeat(CHARS_PER_PAGE * 2)
    const pages = paginateText(single)

    expect(pages).toHaveLength(1)
    expect(pages[0].spans[0].text).toHaveLength(CHARS_PER_PAGE * 2)
  })

  it("refuses bytes that are not text", () => {
    expect(() => extractText("doc", new Uint8Array([0x00, 0x01, 0x02]))).toThrow()
  })
})

describe("redacting plain text", () => {
  it("removes exactly the addressed characters", () => {
    const { document } = extractText("doc", bytes(SOURCE))
    const redaction = redactionFor(document, SENSITIVE.phone)

    const output = textOf(
      redactText(bytes(SOURCE), buildTextPlan(document, [redaction], OPTIONS))
    )

    expect(output).not.toContain(SENSITIVE.phone)
    expect(output).toContain("Phone: ")
    expect(output).toContain("Client notes")
    expect(output).toContain("Naïve café")
  })

  it("preserves every byte it was not asked to touch", () => {
    const source = `a\r\nb\t${SENSITIVE.email}\t c \r\n`
    const { document } = extractText("doc", bytes(source))
    const redaction = redactionFor(document, SENSITIVE.email)

    const output = textOf(
      redactText(bytes(source), buildTextPlan(document, [redaction], OPTIONS))
    )

    expect(output).toBe("a\r\nb\t\t c \r\n")
  })

  it("keeps a byte-order mark", () => {
    const source = `${UTF8_BOM}Email: ${SENSITIVE.email}\n`
    const { document } = extractText("doc", bytes(source))
    const redaction = redactionFor(document, SENSITIVE.email)

    const output = redactText(
      bytes(source),
      buildTextPlan(document, [redaction], OPTIONS)
    )

    // Asserted on the bytes: a decoder eats the mark, which is exactly how one
    // could go missing without any test noticing.
    expect([...output.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(textOf(output)).not.toContain(SENSITIVE.email)
  })

  it("removes a duplicate that sits on another page", () => {
    // The offset of the second occurrence is in a different page's coordinate
    // system. If the plan used page offsets as source offsets, this deletes
    // the wrong characters — and the first copy survives.
    const filler = Array.from(
      { length: 200 },
      (_, index) => `Filler line ${index}.`
    ).join("\n")
    const source = `Email: ${SENSITIVE.email}\n${filler}\nAgain: ${SENSITIVE.email}\n`

    const { document } = extractText("doc", bytes(source))
    expect(document.pages.length).toBeGreaterThan(1)

    const both = [
      redactionFor(document, SENSITIVE.email, 0),
      redactionFor(document, SENSITIVE.email, 1),
    ]

    const output = textOf(
      redactText(bytes(source), buildTextPlan(document, both, OPTIONS))
    )

    expect(output).not.toContain(SENSITIVE.email)
    expect(output).toContain("Filler line 100.")
    expect(output).toContain("Again: ")
  })

  it("writes the label when one was asked for", () => {
    const { document } = extractText("doc", bytes(SOURCE))
    const redaction = redactionFor(document, SENSITIVE.email)

    const output = textOf(
      redactText(
        bytes(SOURCE),
        buildTextPlan(document, [redaction], { ...OPTIONS, addLabels: true })
      )
    )

    expect(output).toContain("Email: [REDACTED]")
  })

  it("ignores a rejected suggestion", () => {
    const { document } = extractText("doc", bytes(SOURCE))
    const rejected: Redaction = {
      ...redactionFor(document, SENSITIVE.phone),
      status: "rejected",
    }

    const output = textOf(
      redactText(bytes(SOURCE), buildTextPlan(document, [rejected], OPTIONS))
    )
    expect(output).toContain(SENSITIVE.phone)
  })

  it("finds and removes what the deterministic detectors propose", async () => {
    const { document } = extractText("doc", bytes(SOURCE))
    const page = document.pages[0]

    const detections = detectPatterns(page.text, { page: page.number })
    expect(detections.some((entry) => entry.text === SENSITIVE.email)).toBe(true)

    const redactions: Redaction[] = detections.map((detection, index) => ({
      id: `det-${index}`,
      documentId: "doc",
      type: "text",
      source: "ai",
      category: detection.category,
      status: "accepted",
      page: detection.page,
      text: detection.text,
      start: detection.start,
      end: detection.end,
    }))

    const output = redactText(
      bytes(SOURCE),
      buildTextPlan(document, redactions, OPTIONS)
    )

    const report = await verifyExport("txt", output, redactions)
    expect(report.passed).toBe(true)
    expect(textOf(output)).not.toContain(SENSITIVE.email)
  })
})
