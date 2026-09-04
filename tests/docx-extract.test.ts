import { describe, expect, it } from "vitest"

import { extractDocx } from "@/lib/documents/docx/extract"
import { makeDocxFixture, makeLongDocxFixture, SENSITIVE } from "./fixtures"

describe("docx extraction", () => {
  it("reads paragraphs, headings and runs", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const page = document.pages[0]
    const blocks = page.blocks ?? []

    expect(document.kind).toBe("docx")
    expect(blocks.length).toBeGreaterThan(0)

    const heading = blocks.find(
      (block) => block.type === "paragraph" && block.headingLevel === 1
    )
    expect(heading).toBeDefined()
  })

  it("preserves run-level formatting", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const runs = (document.pages[0].blocks ?? []).flatMap((block) =>
      block.type === "paragraph" ? block.runs : []
    )

    const bold = runs.find((run) => run.text.startsWith(SENSITIVE.person))
    expect(bold?.style?.bold).toBe(true)

    const italic = runs.find((run) => run.text === SENSITIVE.email)
    expect(italic?.style?.italic).toBe(true)
  })

  it("keeps span offsets aligned with the page text", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const page = document.pages[0]

    expect(page.text).toContain(SENSITIVE.person)
    expect(page.text).toContain(SENSITIVE.email)

    for (const span of page.spans) {
      expect(page.text.slice(span.start, span.end)).toBe(span.text)
      // Addresses are part-qualified: each OOXML part has its own numbering.
      expect(span.blockId).toMatch(/^word\/\w+\.xml#p\d+$/)
      expect(span.id).toMatch(/^word\/\w+\.xml#p\d+r\d+$/)
    }
  })

  it("extracts table cells", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const table = (document.pages[0].blocks ?? []).find(
      (block) => block.type === "table"
    )

    expect(table).toBeDefined()
    if (table?.type !== "table") throw new Error("expected a table")

    expect(table.rows).toHaveLength(2)
    expect(table.rows[0]).toHaveLength(2)
    const accountCell = table.rows[1][1][0]
    expect(accountCell.runs.map((run) => run.text).join("")).toBe(
      SENSITIVE.account
    )
  })

  it("gives every run a unique positional address", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const ids = document.pages.flatMap((page) => page.spans.map((s) => s.id))

    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("docx headers, footers and notes", () => {
  it("extracts header text so it can be reviewed, not just swept", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const blocks = document.pages[0].blocks ?? []

    const header = blocks.filter((block) => block.region === "header")
    expect(header.length).toBeGreaterThan(0)

    const headerText = header
      .flatMap((block) => (block.type === "paragraph" ? block.runs : []))
      .map((run) => run.text)
      .join("")
    expect(headerText).toContain(SENSITIVE.person)
  })

  it("extracts footer text", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const blocks = document.pages[0].blocks ?? []

    const footerText = blocks
      .filter((block) => block.region === "footer")
      .flatMap((block) => (block.type === "paragraph" ? block.runs : []))
      .map((run) => run.text)
      .join("")
    expect(footerText).toContain(SENSITIVE.email)
  })

  it("puts header and footer text into the reviewable text stream", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const page = document.pages[0]

    expect(page.text).toContain("Prepared for")
    expect(page.text).toContain("Contact ")

    // Offsets stay aligned once the extra parts are in the stream.
    for (const span of page.spans) {
      expect(page.text.slice(span.start, span.end)).toBe(span.text)
    }
  })

  it("qualifies every address by its part, so numbering cannot collide", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const ids = document.pages.flatMap((page) => page.spans.map((s) => s.id))

    expect(new Set(ids).size).toBe(ids.length)

    const parts = new Set(ids.map((id) => id.split("#")[0]))
    expect(parts.has("word/document.xml")).toBe(true)
    expect([...parts].some((part) => /header/.test(part))).toBe(true)
    expect([...parts].some((part) => /footer/.test(part))).toBe(true)

    // Each part restarts at p0, which is exactly why the prefix is required.
    const headerIds = ids.filter((id) => /header/.test(id))
    expect(headerIds.some((id) => id.endsWith("#p0r0"))).toBe(true)
  })

  it("orders regions header, body, footer within the page", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const regions = (document.pages[0].blocks ?? []).map(
      (block) => block.region
    )

    const firstBody = regions.indexOf("body")
    const lastHeader = regions.lastIndexOf("header")
    const firstFooter = regions.indexOf("footer")

    expect(lastHeader).toBeLessThan(firstBody)
    expect(firstFooter).toBeGreaterThan(firstBody)
  })
})

describe("docx pagination", () => {
  it("splits a long document into pages without an explicit break", async () => {
    // A DOCX does not record where its pages end — Word decides that at layout
    // time — so a document nobody typed a page break into used to arrive as one
    // page holding everything, with a page rail of one.
    const bytes = await makeLongDocxFixture(120)
    const { document } = extractDocx("doc_1", bytes)

    expect(document.pages.length).toBeGreaterThan(1)
    expect(document.metadata?.pageCount).toBe(document.pages.length)
  })

  it("puts a short document on one page", async () => {
    const bytes = await makeLongDocxFixture(3)
    const { document } = extractDocx("doc_1", bytes)

    expect(document.pages).toHaveLength(1)
  })

  it("keeps every paragraph, and keeps them in order", async () => {
    const bytes = await makeLongDocxFixture(120)
    const { document } = extractDocx("doc_1", bytes)

    const text = document.pages.map((page) => page.text).join("")
    for (const index of [1, 40, 120]) {
      expect(text).toContain(`Paragraph ${index}.`)
    }
    expect(text.indexOf("Paragraph 1.")).toBeLessThan(
      text.indexOf("Paragraph 120.")
    )
  })

  it("still honours a break the author typed", async () => {
    const bytes = await makeLongDocxFixture(4, 1)
    const { document } = extractDocx("doc_1", bytes)

    // Four short paragraphs would otherwise fit on one page.
    expect(document.pages.length).toBeGreaterThan(1)
    expect(document.pages[1].text).toContain("After the break.")
  })

  it("keeps offsets addressed within their own page", async () => {
    // Offsets index into the page's text, and the exporter re-derives runs from
    // them. A span pointing past the end of its page would redact nothing.
    const bytes = await makeLongDocxFixture(120)
    const { document } = extractDocx("doc_1", bytes)

    for (const page of document.pages) {
      for (const span of page.spans) {
        expect(span.end).toBeLessThanOrEqual(page.text.length)
        expect(page.text.slice(span.start, span.end)).toBe(span.text)
      }
    }
  })
})
