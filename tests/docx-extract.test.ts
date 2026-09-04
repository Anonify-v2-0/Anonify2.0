import { describe, expect, it } from "vitest"

import { extractDocx } from "@/lib/documents/docx/extract"
import { makeDocxFixture, SENSITIVE } from "./fixtures"

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
      expect(span.blockId).toMatch(/^p\d+$/)
      expect(span.id).toMatch(/^p\d+r\d+$/)
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
