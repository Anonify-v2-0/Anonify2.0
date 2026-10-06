import { describe, expect, it } from "vitest"

import { chunkPages } from "@/lib/ai/analyze"
import {
  buildEntities,
  dedupeDetections,
  findAllOccurrences,
  joinAdjacent,
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

    const found = findAllOccurrences(model, "John Smith", {
      category: "person",
    })

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

    const found = findAllOccurrences(model, "John Smith", {
      category: "person",
    })
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

  it("folds a detection inside another of its category into it (#205)", () => {
    const outer = detection({ text: "Priya Raman", page: 1, start: 5, end: 16 })
    const deduped = dedupeDetections([
      detection({ text: "Raman", page: 1, start: 11, end: 16 }),
      outer,
      // Inside one of another category, it is a different suggestion.
      detection({
        text: "Raman",
        category: "other",
        page: 1,
        start: 12,
        end: 16,
      }),
      // So is the same span on another page.
      detection({ text: "Raman", page: 2, start: 11, end: 16 }),
      // Cells carry no offsets and are left alone.
      detection({ text: "Raman", worksheet: "Sheet1", row: 2, column: 1 }),
    ])
    expect(deduped).toHaveLength(4)
    expect(deduped[0]).toBe(outer)
    expect(
      deduped.filter((d) => d.category === "person" && d.page === 1)
    ).toEqual([outer])
  })
})

describe("the local search after analysis (#205)", () => {
  const text =
    "Raman wrote from priya.raman@example.org, then Ramanathan and C-77104 called; NC-77104 is a batch. Maras Antrag und Raman."
  const model = doc([page(1, text)])
  const found = (value: string, standalone: boolean) =>
    findAllOccurrences(model, value, { category: "person", standalone }).map(
      (d) => text.slice(d.start, d.end)
    )

  it("finds a value only where it stands on its own", () => {
    expect(found("Raman", true)).toEqual(["Raman", "Raman", "Raman"])
    expect(
      findAllOccurrences(model, "Raman", {
        category: "person",
        standalone: true,
      }).map((d) => d.start)
    ).toEqual([0, 47, text.lastIndexOf("Raman")])
    expect(found("C-77104", true)).toEqual(["C-77104"])
    // An ending is still the name: German writes a genitive without an apostrophe.
    expect(found("Mara", true)).toEqual(["Mara"])
  })

  it("matches inside anything for a reviewer's rule", () => {
    expect(found("Raman", false)).toHaveLength(4)
    expect(found("C-77104", false)).toHaveLength(2)
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
    expect(
      "Contact John   Smith today".slice(located!.start, located!.end)
    ).toBe("John   Smith")
  })

  it("returns null for a value the model invented", () => {
    expect(locateInPage("Contact Jane today", "John Smith")).toBeNull()
  })

  it("does not treat the value as a regular expression", () => {
    expect(locateInPage("price is $5.00 (net)", "$5.00 (net)")).not.toBeNull()
  })
})

describe("joining a pattern's value to the model's part of it (#207)", () => {
  const text =
    "Ship to 42 Larch Court, Flat 3, Stowmarket, IP14 2RN today. Priya Raman, John Smith signed. Also 42 Larch Court on its own."
  const pages = new Map([[1, text]])
  const span = (value: string, category: string, from = 0): Detection => {
    const start = text.indexOf(value, from)
    return {
      text: value,
      category,
      confidence: 0.8,
      page: 1,
      start,
      end: start + value.length,
    }
  }
  const street = span("42 Larch Court", "address")
  const rest = span("Flat 3, Stowmarket, IP14 2RN", "address")
  const alone = span("42 Larch Court", "address", 60)
  const priya = span("Priya Raman", "person")
  const john = span("John Smith", "person")

  it("joins a street line and the rest of its address into one suggestion", () => {
    const joined = joinAdjacent(
      [street, rest, priya, john, alone],
      { patterns: [street, alone], model: [rest, priya, john] },
      pages
    )
    expect(joined.map((d) => d.text)).toEqual([
      "42 Larch Court, Flat 3, Stowmarket, IP14 2RN",
      "Priya Raman",
      "John Smith",
      "42 Larch Court",
    ])
    expect(joined[0]).toMatchObject({ start: street.start, end: rest.end })
  })

  it("joins the local search's copy of a value as the model's own", () => {
    const twice =
      "Visit 735 Meadowlark Avenue, Reno, NV 89509 or write to Reno, NV 89509. Again: 735 Meadowlark Avenue, Reno, NV 89509."
    const at = (value: string, nth = 0): Detection => {
      let start = twice.indexOf(value)
      for (let i = 0; i < nth; i++) start = twice.indexOf(value, start + 1)
      return {
        text: value,
        category: "address",
        confidence: 0.8,
        page: 1,
        start,
        end: start + value.length,
      }
    }
    const street = at("735 Meadowlark Avenue")
    const town = at("Reno, NV 89509", 1)
    // The second occurrences are what the local search added.
    const streetAgain = at("735 Meadowlark Avenue", 1)
    const townAgain = at("Reno, NV 89509", 2)
    const joined = joinAdjacent(
      [street, at("Reno, NV 89509"), town, streetAgain, townAgain],
      { patterns: [street], model: [town] },
      new Map([[1, twice]])
    )
    expect(joined.map((d) => d.text)).toEqual([
      "735 Meadowlark Avenue, Reno, NV 89509",
      "Reno, NV 89509",
      "735 Meadowlark Avenue, Reno, NV 89509",
    ])
  })

  it("joins a value found in three pieces", () => {
    const flat = span("Flat 3", "address")
    const town = span("Stowmarket, IP14 2RN", "address")
    const joined = joinAdjacent(
      [street, flat, town],
      { patterns: [flat], model: [street, town] },
      pages
    )
    expect(joined.map((d) => d.text)).toEqual([
      "42 Larch Court, Flat 3, Stowmarket, IP14 2RN",
    ])
  })

  it("leaves apart two values the model found, another category, or more than a comma between", () => {
    expect(
      joinAdjacent(
        [street, rest],
        { patterns: [], model: [street, rest] },
        pages
      )
    ).toHaveLength(2)
    const phone = { ...rest, category: "phone" }
    expect(
      joinAdjacent(
        [street, phone],
        { patterns: [street], model: [phone] },
        pages
      )
    ).toHaveLength(2)
    const later = span("IP14 2RN", "address")
    expect(
      joinAdjacent(
        [street, later],
        { patterns: [street], model: [later] },
        pages
      )
    ).toHaveLength(2)
  })
})
