import { describe, expect, it } from "vitest"

import { chunkPages } from "@/lib/ai/analyze"
import {
  buildEntities,
  dedupeDetections,
  findAllOccurrences,
  locateInPage,
} from "@/lib/redaction/entities"
import type { NormalizedDocument } from "@/types/document"
import type { Detection } from "@/types/redaction"

function page(number: number, text: string) {
  return { number, width: 612, height: 792, text, spans: [] }
}

function doc(pages: ReturnType<typeof page>[]): NormalizedDocument {
  return { documentId: "doc_1", kind: "pdf", pages }
}

function detection(overrides: Partial<Detection> = {}): Detection {
  return {
    text: "John Smith",
    category: "person",
    confidence: 0.9,
    ...overrides,
  }
}

describe("chunking", () => {
  it("leaves a short page as a single chunk", () => {
    const chunks = chunkPages(doc([page(1, "short text")]))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].offset).toBe(0)
  })

  it("splits a long page and keeps offsets contiguous", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")
    const chunks = chunkPages(doc([page(1, text)]), 500)

    expect(chunks.length).toBeGreaterThan(1)
    let cursor = 0
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(cursor)
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(
        chunk.text
      )
      cursor += chunk.text.length
    }
    expect(cursor).toBe(text.length)
  })

  it("prefers to break on a line boundary", () => {
    const text = `${"a".repeat(300)}\n${"b".repeat(300)}`
    const chunks = chunkPages(doc([page(1, text)]), 400)
    expect(chunks[0].text.endsWith("\n")).toBe(true)
  })

  it("skips empty pages", () => {
    const chunks = chunkPages(doc([page(1, "   "), page(2, "content")]))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].page).toBe(2)
  })
})

describe("entities", () => {
  it("collapses repeated values into one entity with a count", () => {
    const entities = buildEntities([
      detection({ page: 1 }),
      detection({ page: 2 }),
      detection({ text: "JOHN SMITH", page: 3 }),
      detection({ text: "jane@example.com", category: "email" }),
    ])

    expect(entities).toHaveLength(2)
    const person = entities.find((entity) => entity.category === "person")
    expect(person?.occurrences).toBe(3)
  })

  it("keeps the most confident reading of a repeated value", () => {
    const entities = buildEntities([
      detection({ confidence: 0.4, category: "other" }),
      detection({ confidence: 0.95, category: "person" }),
    ])

    expect(entities[0].category).toBe("person")
    expect(entities[0].confidence).toBe(0.95)
  })

  it("finds every occurrence across pages without another model call", () => {
    const model = doc([
      page(1, "John Smith met Jane. John Smith signed."),
      page(2, "Regards, John Smith"),
    ])

    const found = findAllOccurrences(model, "John Smith", { category: "person" })

    expect(found).toHaveLength(3)
    expect(found.every((item) => item.global)).toBe(true)
    for (const item of found) {
      const text = model.pages[item.page! - 1].text
      expect(text.slice(item.start, item.end)).toBe("John Smith")
    }
  })

  it("finds occurrences in spreadsheet cells", () => {
    const model: NormalizedDocument = {
      documentId: "doc_1",
      kind: "xlsx",
      pages: [],
      sheets: [
        {
          name: "Sheet1",
          rowCount: 3,
          columnCount: 1,
          headers: ["Name"],
          cells: [
            { row: 2, column: 1, value: "John Smith" },
            { row: 3, column: 1, value: "Jane Doe" },
          ],
        },
      ],
    }

    const found = findAllOccurrences(model, "John Smith", { category: "person" })
    expect(found).toHaveLength(1)
    expect(found[0].worksheet).toBe("Sheet1")
    expect(found[0].row).toBe(2)
  })

  it("drops duplicate detections that cover the same location", () => {
    const deduped = dedupeDetections([
      detection({ page: 1, start: 0, end: 10, confidence: 0.6 }),
      detection({ page: 1, start: 0, end: 10, confidence: 0.9 }),
      detection({ page: 2, start: 0, end: 10 }),
    ])

    expect(deduped).toHaveLength(2)
    expect(deduped.find((item) => item.page === 1)?.confidence).toBe(0.9)
  })
})

describe("locating model output", () => {
  it("finds an exact match", () => {
    const located = locateInPage("Contact John Smith today", "John Smith")
    expect(located).toEqual({ start: 8, end: 18 })
  })

  it("tolerates whitespace that extraction changed", () => {
    const located = locateInPage("Contact John   Smith today", "John Smith")
    expect(located).not.toBeNull()
    expect("Contact John   Smith today".slice(located!.start, located!.end)).toBe(
      "John   Smith"
    )
  })

  it("returns null for a value the model invented", () => {
    expect(locateInPage("Contact Jane today", "John Smith")).toBeNull()
  })

  it("does not treat the value as a regular expression", () => {
    expect(locateInPage("price is $5.00 (net)", "$5.00 (net)")).not.toBeNull()
  })
})
