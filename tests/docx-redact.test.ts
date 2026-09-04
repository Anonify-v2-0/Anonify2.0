import { describe, expect, it } from "vitest"

import { extractDocx } from "@/lib/documents/docx/extract"
import { openPackage, readPart } from "@/lib/documents/docx/ooxml"
import { redactDocx } from "@/lib/documents/docx/redact"
import { makeDocxFixture, SENSITIVE } from "./fixtures"

/** Every text-bearing part, concatenated, as a hostile reader would see it. */
function allPartText(bytes: Uint8Array): string {
  const pkg = openPackage(bytes)
  return Object.keys(pkg.files)
    .filter((name) => name.endsWith(".xml"))
    .map((name) => readPart(pkg, name) ?? "")
    .join("\n")
}

function runEditsFor(bytes: Uint8Array, value: string) {
  const { document } = extractDocx("doc_1", bytes)
  const edits: Record<string, { start: number; end: number }[]> = {}

  for (const page of document.pages) {
    for (const span of page.spans) {
      const index = span.text.indexOf(value)
      if (index === -1) continue
      edits[span.id] = [{ start: index, end: index + value.length }]
    }
  }

  return edits
}

describe("docx redaction", () => {
  it("leaves the document intact when nothing is accepted", async () => {
    const bytes = await makeDocxFixture()
    const output = redactDocx(bytes, {
      runEdits: {},
      values: [],
      label: null,
      sanitizeMetadata: false,
    })

    const before = extractDocx("doc_1", bytes).document
    const after = extractDocx("doc_1", output).document

    expect(after.pages[0].text).toBe(before.pages[0].text)
  })

  it("removes an accepted value from the document XML", async () => {
    const bytes = await makeDocxFixture()
    const output = redactDocx(bytes, {
      runEdits: runEditsFor(bytes, SENSITIVE.email),
      values: [SENSITIVE.email],
      label: null,
      sanitizeMetadata: false,
    })

    expect(allPartText(output)).not.toContain(SENSITIVE.email)
    // Untouched content is still there.
    expect(allPartText(output)).toContain("Example Corporation")
  })

  it("removes a value that appears in a table cell", async () => {
    const bytes = await makeDocxFixture()
    const output = redactDocx(bytes, {
      runEdits: runEditsFor(bytes, SENSITIVE.account),
      values: [SENSITIVE.account],
      label: null,
      sanitizeMetadata: false,
    })

    expect(allPartText(output)).not.toContain(SENSITIVE.account)
    expect(allPartText(output)).toContain("Account")
  })

  it("removes every occurrence of a globally accepted value", async () => {
    const bytes = await makeDocxFixture()
    const before = extractDocx("doc_1", bytes).document.pages[0].text
    expect(before.split(SENSITIVE.person).length - 1).toBeGreaterThan(1)

    const output = redactDocx(bytes, {
      runEdits: {},
      values: [SENSITIVE.person],
      label: null,
      sanitizeMetadata: false,
    })

    expect(allPartText(output)).not.toContain(SENSITIVE.person)
  })

  it("writes a visible marker when one is requested", async () => {
    const bytes = await makeDocxFixture()
    const output = redactDocx(bytes, {
      runEdits: runEditsFor(bytes, SENSITIVE.email),
      values: [SENSITIVE.email],
      label: "[REDACTED]",
      sanitizeMetadata: false,
    })

    const text = extractDocx("doc_1", output).document.pages[0].text
    expect(text).toContain("[REDACTED]")
    expect(text).not.toContain(SENSITIVE.email)
  })

  it("preserves formatting on surviving runs", async () => {
    const bytes = await makeDocxFixture()
    const output = redactDocx(bytes, {
      runEdits: runEditsFor(bytes, SENSITIVE.email),
      values: [SENSITIVE.email],
      label: null,
      sanitizeMetadata: false,
    })

    const blocks = extractDocx("doc_1", output).document.pages[0].blocks ?? []
    const heading = blocks.find(
      (block) => block.type === "paragraph" && block.headingLevel === 1
    )
    expect(heading).toBeDefined()

    const boldRun = blocks
      .flatMap((block) => (block.type === "paragraph" ? block.runs : []))
      .find((run) => run.text.startsWith("John"))
    expect(boldRun?.style?.bold).toBe(true)

    const table = blocks.find((block) => block.type === "table")
    expect(table).toBeDefined()
  })

  it("strips authorship metadata when asked", async () => {
    const bytes = await makeDocxFixture()
    const output = redactDocx(bytes, {
      runEdits: {},
      values: [],
      label: null,
      sanitizeMetadata: true,
    })

    const core = readPart(openPackage(output), "docProps/core.xml") ?? ""
    expect(core).not.toMatch(/<dc:creator[^>]*>[^<]+<\/dc:creator>/)
    expect(core).toContain("<dc:creator></dc:creator>")
  })

  it("produces a file that still opens as a DOCX", async () => {
    const bytes = await makeDocxFixture()
    const output = redactDocx(bytes, {
      runEdits: runEditsFor(bytes, SENSITIVE.email),
      values: [SENSITIVE.email],
      label: null,
      sanitizeMetadata: true,
    })

    const pkg = openPackage(output)
    expect(pkg.files["[Content_Types].xml"]).toBeDefined()
    expect(pkg.files["word/document.xml"]).toBeDefined()
    expect(() => extractDocx("doc_1", output)).not.toThrow()
  })
})
