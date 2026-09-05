import { describe, expect, it } from "vitest"

import { extractDocx } from "@/lib/documents/docx/extract"
import { openPackage, readPart } from "@/lib/documents/ooxml/package"
import { redactDocx } from "@/lib/documents/docx/redact"
import { buildDocxPlan } from "@/lib/redaction/apply"
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

  it("writes one marker for a value split across runs", async () => {
    // Word breaks text at every formatting change, so the bolded name and the
    // sentence after it are two runs carrying one phrase. Each run used to
    // believe it was the first to place a marker, and the export came back
    // reading "[REDACTED][REDACTED]" where one value had been.
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const value = `${SENSITIVE.person} works at`

    const page = document.pages[0]
    const start = page.text.indexOf(value)
    expect(start).toBeGreaterThanOrEqual(0)

    // Two runs really do carry it: no single span holds the whole phrase.
    expect(page.spans.some((span) => span.text.includes(value))).toBe(false)

    const plan = buildDocxPlan(
      document,
      [
        {
          id: "split",
          documentId: "doc_1",
          type: "text",
          source: "user",
          category: "person",
          status: "accepted",
          page: page.number,
          text: value,
          start,
          end: start + value.length,
        },
      ],
      { addLabels: true, sanitizeMetadata: false }
    )

    const output = redactDocx(bytes, plan)

    const text = extractDocx("doc_1", output).document.pages[0].text
    expect(text).not.toContain(value)
    expect(text.match(/\[REDACTED\]/g)).toHaveLength(1)
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

describe("docx redaction across parts", () => {
  it("redacts a value that appears only in the header, by address", async () => {
    const bytes = await makeDocxFixture()
    const { document } = extractDocx("doc_1", bytes)
    const page = document.pages[0]

    // Target the header run specifically, with no value sweep to fall back on.
    const headerSpan = page.spans.find(
      (span) => /header/.test(span.id) && span.text.includes(SENSITIVE.person)
    )
    expect(headerSpan).toBeDefined()

    const index = headerSpan!.text.indexOf(SENSITIVE.person)
    const output = redactDocx(bytes, {
      runEdits: {
        [headerSpan!.id]: [
          { start: index, end: index + SENSITIVE.person.length },
        ],
      },
      values: [],
      label: null,
      sanitizeMetadata: false,
    })

    const after = extractDocx("doc_1", output).document.pages[0]
    const headerText = (after.blocks ?? [])
      .filter((block) => block.region === "header")
      .flatMap((block) => (block.type === "paragraph" ? block.runs : []))
      .map((run) => run.text)
      .join("")

    expect(headerText).not.toContain(SENSITIVE.person)
    // The body copy of the same name is untouched: this was an address edit,
    // not a package-wide sweep.
    expect(after.text).toContain(SENSITIVE.person)
  })

  it("does not let one part's numbering edit another part", async () => {
    const bytes = await makeDocxFixture()
    const before = extractDocx("doc_1", bytes).document.pages[0]

    // p0r0 exists in the header, the footer and the body. Addressing only the
    // header's must leave the other two alone.
    const output = redactDocx(bytes, {
      runEdits: { "word/header1.xml#p0r0": [{ start: 0, end: 8 }] },
      values: [],
      label: null,
      sanitizeMetadata: false,
    })

    const after = extractDocx("doc_1", output).document.pages[0]
    const bodyOf = (page: typeof before) =>
      (page.blocks ?? [])
        .filter((block) => block.region === "body")
        .flatMap((block) => (block.type === "paragraph" ? block.runs : []))
        .map((run) => run.text)
        .join("")

    expect(bodyOf(after)).toBe(bodyOf(before))
  })
})
