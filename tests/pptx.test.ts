import { describe, expect, it } from "vitest"

import {
  listParts,
  openPackage,
  PPTX_TEXT_PARTS,
  readPart,
} from "@/lib/documents/ooxml/package"
import { extractPptx, slideOrder } from "@/lib/documents/pptx/extract"
import { redactPptx } from "@/lib/documents/pptx/redact"
import { buildDocxPlan } from "@/lib/redaction/apply"
import { detectPatterns } from "@/lib/redaction/detectors"
import { verifyExport } from "@/lib/redaction/validation"
import type { NormalizedDocument } from "@/types/document"
import type { Redaction } from "@/types/redaction"

import { DECK, makePptxFixture } from "./pptx-fixtures"

/**
 * PPTX.
 *
 * A deck hides text in four places and only one of them is on the screen: the
 * slides, the speaker notes, the layouts and the master. The notes are the
 * ones people are most surprised by — not projected, not printed, shipped with
 * the file — and a pipeline that reads only `ppt/slides/*.xml` leaves three of
 * the four in the exported document.
 *
 * So every export assertion here reads the *whole package*, not the slides.
 */

const OPTIONS = { addLabels: false, sanitizeMetadata: true }

function partsOf(bytes: Uint8Array): Record<string, string> {
  const pkg = openPackage(bytes)
  return Object.fromEntries(
    Object.keys(pkg.files)
      .filter((name) => name.endsWith(".xml") || name.endsWith(".rels"))
      .map((name) => [name, readPart(pkg, name) ?? ""])
  )
}

function packageText(bytes: Uint8Array): string {
  return Object.values(partsOf(bytes)).join("\n")
}

function redactionFor(
  model: NormalizedDocument,
  value: string
): Redaction {
  for (const page of model.pages) {
    const index = page.text.indexOf(value)
    if (index === -1) continue
    return {
      id: `red-${value}-${page.number}`,
      documentId: "doc",
      type: "text",
      source: "ai",
      category: "person",
      status: "accepted",
      page: page.number,
      text: value,
      start: index,
      end: index + value.length,
    }
  }
  throw new Error(`${value} is not in the extracted text`)
}

describe("extracting a deck", () => {
  it("makes one page per slide", () => {
    const { document, slides } = extractPptx("doc", makePptxFixture())

    expect(document.kind).toBe("pptx")
    expect(slides).toHaveLength(2)
    expect(document.metadata?.slideCount).toBe(2)
    expect(document.pages[0].text).toContain("Account review for")
    expect(document.pages[1].text).toContain("Next steps")
  })

  it("joins text a formatting change split across runs", () => {
    // Three runs in the file, one address to a reader — and no substring of
    // the XML contains it.
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)

    expect(document.pages[0].text).toContain("john@example.com")
    expect(readPart(openPackage(bytes), "ppt/slides/slide1.xml")).not.toContain(
      "john@example.com"
    )
  })

  it("reads the speaker notes onto the slide they belong to", () => {
    const { document } = extractPptx("doc", makePptxFixture())

    expect(document.pages[0].text).toContain("[speaker notes]")
    expect(document.pages[0].text).toContain("asked about the")
    expect(document.pages[0].text).toContain(DECK.phone)
    // Slide two has no notes, and does not borrow slide one's.
    expect(document.pages[1].text).not.toContain("[speaker notes]")
  })

  it("reads the layout and the master, which no slide contains", () => {
    const { document } = extractPptx("doc", makePptxFixture())
    const text = document.pages.map((page) => page.text).join("\n")

    expect(text).toContain(`Prepared for ${DECK.client}`)
    expect(text).toContain(`${DECK.client} — confidential`)
    expect(document.pages.length).toBeGreaterThan(2)
  })

  it("addresses every span by part, paragraph and run", () => {
    const { document } = extractPptx("doc", makePptxFixture())

    for (const page of document.pages) {
      for (const span of page.spans) {
        expect(span.id).toMatch(/^ppt\/[^#]+\.xml#p\d+(r|fld)\d+$/)
      }
    }

    const slideSpans = document.pages[0].spans.filter((span) =>
      span.id.startsWith("ppt/slides/slide1.xml")
    )
    expect(slideSpans.length).toBeGreaterThan(0)
  })

  it("follows the deck's own slide order, not the file numbering", () => {
    // Reordering slides in PowerPoint rewrites `sldIdLst` and leaves the
    // filenames alone, so numeric order would review the deck backwards.
    const reversed = makePptxFixture({ reversed: true })
    expect(slideOrder(openPackage(reversed))).toEqual([
      "ppt/slides/slide2.xml",
      "ppt/slides/slide1.xml",
    ])

    const { document } = extractPptx("doc", reversed)
    expect(document.pages[0].text).toContain("Next steps")
  })

  it("refuses a package that is not a deck", () => {
    expect(() =>
      extractPptx("doc", new Uint8Array(Buffer.from("not a zip")))
    ).toThrow()
  })
})

describe("redacting a deck", () => {
  it("removes a value from the slide it was found on", () => {
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)
    const output = redactPptx(
      bytes,
      buildDocxPlan(document, [redactionFor(document, DECK.person)], OPTIONS)
    )

    const slide = readPart(openPackage(output), "ppt/slides/slide1.xml") ?? ""
    expect(slide).not.toContain(DECK.person)
    expect(slide).toContain("Account review for")
  })

  it("removes a value split across runs", () => {
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)
    const output = redactPptx(
      bytes,
      buildDocxPlan(
        document,
        [redactionFor(document, "john@example.com")],
        OPTIONS
      )
    )

    const reopened = extractPptx("verify", output)
    expect(reopened.document.pages[0].text).not.toContain("john@example.com")
    // The runs themselves survive; only characters were removed.
    expect(readPart(openPackage(output), "ppt/slides/slide1.xml")).toContain(
      "<a:r>"
    )
  })

  it("sweeps the value out of the notes, the layout and the master", () => {
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)

    // Accepted on the slide only. Everywhere else is the sweep's job, and
    // those are the three places a slides-only pipeline leaves behind.
    const output = redactPptx(
      bytes,
      buildDocxPlan(document, [redactionFor(document, DECK.phone)], OPTIONS)
    )

    expect(packageText(output)).not.toContain(DECK.phone)
    expect(readPart(openPackage(output), "ppt/notesSlides/notesSlide1.xml")).not.toContain(
      DECK.phone
    )
  })

  it("removes a value that lives only on the master", () => {
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)
    const output = redactPptx(
      bytes,
      buildDocxPlan(document, [redactionFor(document, DECK.client)], OPTIONS)
    )

    expect(packageText(output)).not.toContain(DECK.client)
  })

  it("removes every occurrence across slides", () => {
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)
    const output = redactPptx(
      bytes,
      buildDocxPlan(document, [redactionFor(document, DECK.person)], OPTIONS)
    )

    const reopened = extractPptx("verify", output)
    for (const page of reopened.document.pages) {
      expect(page.text).not.toContain(DECK.person)
    }
  })

  it("strips authorship when asked", () => {
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)
    const output = redactPptx(
      bytes,
      buildDocxPlan(document, [redactionFor(document, DECK.person)], OPTIONS)
    )

    const parts = partsOf(output)
    expect(parts["docProps/core.xml"]).not.toContain(DECK.author)
    expect(parts["docProps/app.xml"]).not.toContain(DECK.client)
  })

  it("leaves the package structurally intact", () => {
    const bytes = makePptxFixture()
    const before = partsOf(bytes)
    const { document } = extractPptx("doc", bytes)

    const output = redactPptx(
      bytes,
      buildDocxPlan(document, [redactionFor(document, DECK.person)], OPTIONS)
    )
    const after = partsOf(output)

    // Every part still there, and the ones nothing touched are unchanged.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    expect(after["[Content_Types].xml"]).toBe(before["[Content_Types].xml"])
    expect(after["ppt/_rels/presentation.xml.rels"]).toBe(
      before["ppt/_rels/presentation.xml.rels"]
    )

    // And it reopens as a deck with the same slides.
    const reopened = extractPptx("verify", output)
    expect(reopened.slides).toEqual(extractPptx("doc", bytes).slides)
    expect(listParts(openPackage(output), PPTX_TEXT_PARTS).length).toBe(
      listParts(openPackage(bytes), PPTX_TEXT_PARTS).length
    )
  })

  it("writes one marker for a value scattered across runs", () => {
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)
    const output = redactPptx(
      bytes,
      buildDocxPlan(document, [redactionFor(document, "john@example.com")], {
        ...OPTIONS,
        addLabels: true,
      })
    )

    const slide = readPart(openPackage(output), "ppt/slides/slide1.xml") ?? ""
    expect(slide.match(/\[REDACTED\]/g)).toHaveLength(1)
  })

  it("ignores a rejected suggestion", () => {
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)
    const rejected: Redaction = {
      ...redactionFor(document, DECK.person),
      status: "rejected",
    }

    const output = redactPptx(bytes, buildDocxPlan(document, [rejected], OPTIONS))
    expect(packageText(output)).toContain(DECK.person)
  })
})

describe("verifying an exported deck", () => {
  it("passes only once the value is gone from every part", async () => {
    const bytes = makePptxFixture()
    const { document } = extractPptx("doc", bytes)

    const redactions: Redaction[] = document.pages.flatMap((page) =>
      detectPatterns(page.text, { page: page.number }).map(
        (detection, index) => ({
          id: `det-${page.number}-${index}`,
          documentId: "doc",
          type: "text" as const,
          source: "ai" as const,
          category: detection.category,
          status: "accepted" as const,
          page: detection.page,
          text: detection.text,
          start: detection.start,
          end: detection.end,
        })
      )
    )

    expect(redactions.length).toBeGreaterThan(0)

    const output = redactPptx(bytes, buildDocxPlan(document, redactions, OPTIONS))

    const report = await verifyExport("pptx", output, redactions)
    expect(report.passed).toBe(true)

    const untouched = await verifyExport("pptx", bytes, redactions)
    expect(untouched.passed).toBe(false)
  })

  it("reads the whole package, not the visible slide text", async () => {
    // A value only in the notes has to fail verification if it survives, which
    // means the haystack cannot be "what the reviewer saw".
    const bytes = makePptxFixture()
    const notesOnly: Redaction = {
      id: "notes",
      documentId: "doc",
      type: "text",
      source: "user",
      category: "phone",
      status: "accepted",
      text: DECK.phone,
    }

    const report = await verifyExport("pptx", bytes, [notesOnly])
    expect(report.passed).toBe(false)
    expect(report.leaked).toContain(DECK.phone)
  })
})
