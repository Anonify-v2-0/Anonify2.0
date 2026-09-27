import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { extractDelimited } from "@/lib/documents/delimited/extract"
import { extractDocx } from "@/lib/documents/docx/extract"
import { extractEml } from "@/lib/documents/eml/extract"
import { openNormalized, saveNormalized } from "@/lib/documents/normalized-store"
import { extractPdf } from "@/lib/documents/pdf/extract"
import { extractPptx } from "@/lib/documents/pptx/extract"
import { extractRtf } from "@/lib/documents/rtf/extract"
import { extractText } from "@/lib/documents/text/extract"
import { boxesForRange } from "@/lib/redaction/geometry"
import { compilePattern, type PatternSpec } from "@/lib/redaction/patterns"
import { findRuleMatches } from "@/lib/redaction/rules"
import {
  diffMatches,
  previewMatches,
  sampleAround,
  searchPage,
  summarizeSearch,
} from "@/lib/redaction/search"
import { newDocumentSeal } from "@/lib/storage/sealed"
import { locateHit } from "@/store/searchSlice"
import type { NormalizedDocument } from "@/types/document"

import { bytesOf, mixedEml } from "./eml-fixtures"
import { makeDocxFixture, makePdfFixture } from "./fixtures"
import { makePptxFixture } from "./pptx-fixtures"

/**
 * Search runs on the server, over the stored model, a page at a time. What
 * has to hold for every format with a review view: each hit's offsets point
 * at exactly the characters that matched in that page's text — the offsets
 * the viewer paints and a redaction would carry — and the count the search bar
 * shows is the count a rule over the same pattern would write.
 */

const ROOT = path.join(process.cwd(), ".anonify-storage", "documents")
const created: string[] = []

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64")
})

afterAll(async () => {
  await Promise.all(
    created.map((id) => rm(path.join(ROOT, id), { recursive: true, force: true }))
  )
})

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"))
}

async function reader(model: NormalizedDocument) {
  const id = `doc_search_${randomBytes(6).toString("hex")}`
  created.push(id)
  const seal = newDocumentSeal()
  const saved = await saveNormalized(id, seal, { ...model, documentId: id })
  return openNormalized({ documentId: id, blobKey: saved.key, seal, index: saved.index })
}

const literal = (pattern: string): PatternSpec => ({
  kind: "literal",
  pattern,
  matchCase: false,
  wholeWord: false,
})

const regex = (pattern: string): PatternSpec => ({
  kind: "regex",
  pattern,
  matchCase: false,
  wholeWord: false,
})

async function formats(): Promise<[string, NormalizedDocument][]> {
  const pdf = await makePdfFixture([
    [{ text: "Page one: John Smith" }],
    [{ text: "Page two: nobody" }],
    [{ text: "Page three: john smith again" }],
  ])
  return [
    ["text", extractText("t", utf8("Call John Smith.\nJohn Smith called back.")).document],
    ["rtf", extractRtf("r", utf8("{\\rtf1\\ansi John Smith\\par jane@example.com}")).document],
    ["pdf", (await extractPdf("p", pdf)).document],
    ["docx", extractDocx("d", await makeDocxFixture()).document],
    ["pptx", extractPptx("s", makePptxFixture()).document],
    ["eml", extractEml("e", bytesOf(mixedEml())).document],
  ]
}

describe("searching a stored document", () => {
  it("reports offsets that point at the matched text, in every page-based format", async () => {
    for (const [name, model] of await formats()) {
      const stored = await reader(model)
      // Something every fixture contains, whatever it is.
      const probe = model.pages.find((page) => page.text.trim())?.text.trim().split(/\s+/)[0]
      expect(probe, name).toBeTruthy()
      const compiled = compilePattern(literal(probe as string))

      const summary = await summarizeSearch(stored, compiled)
      expect(summary.total, name).toBeGreaterThan(0)

      let total = 0
      for (const entry of summary.pages) {
        const page = model.pages.find((candidate) => candidate.number === entry.page)
        const hits = await searchPage(stored, compiled, entry.page)
        expect(hits.length, name).toBe(entry.count)
        for (const hit of hits) {
          expect(page?.text.slice(hit.start, hit.end).toLowerCase(), name).toBe(
            (probe as string).toLowerCase()
          )
        }
        total += entry.count
      }
      expect(total, name).toBe(summary.total)
    }
  })

  it("counts exactly what a rule over the same pattern would write", async () => {
    for (const [name, model] of await formats()) {
      const stored = await reader(model)
      for (const spec of [literal("john smith"), regex("\\b[A-Z][a-z]+\\b")]) {
        const compiled = compilePattern(spec)
        const [summary, preview, written] = await Promise.all([
          summarizeSearch(stored, compiled),
          previewMatches(stored, compiled),
          findRuleMatches(stored, compiled, { category: "person" }),
        ])
        expect(summary.total, name).toBe(written.length)
        expect(preview.count, name).toBe(written.length)
      }
    }
  })

  it("finds cells in a spreadsheet, once per cell however often it matches", async () => {
    const csv = extractDelimited(
      "c",
      "csv",
      utf8("name,note\nJohn Smith,met John Smith twice\nJane,none\n")
    ).document
    const stored = await reader(csv)
    const summary = await summarizeSearch(stored, compilePattern(literal("john smith")))

    expect(summary.pages).toEqual([])
    expect(summary.total).toBe(2)
    expect(summary.cells.map((cell) => [cell.row, cell.column])).toEqual([
      [2, 1],
      [2, 2],
    ])
    expect(locateHit(summary.pages, summary.cells, 1)).toEqual({
      kind: "cell",
      cell: summary.cells[1],
    })
  })

  it("places an OCR hit on the pixels its words cover", () => {
    const page = {
      number: 1,
      width: 400,
      height: 100,
      text: "Patient MRN 4481923",
      ocr: true,
      spans: [
        { id: "w1", text: "Patient", start: 0, end: 7, geometry: "word" as const, boundingBox: { x: 10, y: 10, width: 70, height: 20 } },
        { id: "w2", text: "MRN", start: 8, end: 11, geometry: "word" as const, boundingBox: { x: 90, y: 10, width: 30, height: 20 } },
        { id: "w3", text: "4481923", start: 12, end: 19, geometry: "word" as const, boundingBox: { x: 130, y: 10, width: 70, height: 20 } },
      ],
    }
    const [hit] = compilePattern(regex("MRN \\d{7}")).find(page.text)
    const boxes = boxesForRange(page, hit.start, hit.end)
    expect(boxes).toHaveLength(2)
    expect(boxes[0].x).toBe(90)
    expect(boxes[1].x).toBe(130)
  })

  it("orders hits across pages for next and previous", () => {
    const pages = [
      { page: 2, count: 2 },
      { page: 5, count: 1 },
    ]
    expect(locateHit(pages, [], 0)).toEqual({ kind: "page", page: 2, index: 0 })
    expect(locateHit(pages, [], 1)).toEqual({ kind: "page", page: 2, index: 1 })
    expect(locateHit(pages, [], 2)).toEqual({ kind: "page", page: 5, index: 0 })
    expect(locateHit(pages, [], 3)).toBeNull()
  })
})

describe("previews and diffs", () => {
  it("shows a match with the text around it, folded onto one line", () => {
    const text = "first line\nwith EMP-00123 in it\nlast"
    const [range] = compilePattern(regex("EMP-\\d+")).find(text)
    expect(sampleAround(text, range, 10)).toEqual({
      before: "…line with ",
      match: "EMP-00123",
      after: " in it las…",
    })
  })

  it("says which matches a tightened pattern gains and loses", async () => {
    const stored = await reader(
      extractText(
        "t",
        utf8("EMP-00123 and EMP-00456 but not ORDER-99999 or EMP-12")
      ).document
    )
    const diff = await diffMatches(
      stored,
      compilePattern(regex("[A-Z]+-\\d+")),
      compilePattern(regex("EMP-\\d{5}"))
    )
    expect(diff.before).toBe(4)
    expect(diff.after).toBe(2)
    expect(diff.gainedCount).toBe(0)
    expect(diff.lost.map((sample) => sample.match)).toEqual(["ORDER-99999", "EMP-12"])
  })
})
