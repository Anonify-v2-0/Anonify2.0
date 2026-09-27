import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { extractDelimited, DelimitedExtractionStream } from "@/lib/documents/delimited/extract"
import { extractDocx } from "@/lib/documents/docx/extract"
import { extractEml } from "@/lib/documents/eml/extract"
import {
  parseNormalizedIndex,
  serializeNormalized,
  type NormalizedIndex,
} from "@/lib/documents/normalized-json"
import {
  loadTextModel,
  openNormalized,
  saveNormalized,
  saveNormalizedStream,
  withPages,
} from "@/lib/documents/normalized-store"
import { extractPdf } from "@/lib/documents/pdf/extract"
import { extractPptx } from "@/lib/documents/pptx/extract"
import { extractRtf } from "@/lib/documents/rtf/extract"
import { extractText, TextExtractionStream } from "@/lib/documents/text/extract"
import {
  buildDocxPlan,
  buildEmlPlan,
  buildPdfPlan,
  buildTextPlan,
  pagesReadByExport,
} from "@/lib/redaction/apply"
import { findAllOccurrences } from "@/lib/redaction/entities"
import { findOccurrencesIn } from "@/lib/redaction/rules"
import { normalizedKey } from "@/lib/storage/blob"
import { newDocumentSeal, type DocumentSeal } from "@/lib/storage/sealed"
import { CHUNK_SIZE_ENV } from "@/lib/storage/streaming"
import type { NormalizedDocument } from "@/types/document"
import type { Redaction } from "@/types/redaction"

import { bytesOf, mixedEml, quotedReplyEml } from "./eml-fixtures"
import { makeDocxFixture, makeLongDocxFixture, makePdfFixture } from "./fixtures"
import { makePptxFixture } from "./pptx-fixtures"

/**
 * The normalized model, a page at a time.
 *
 * The model is stored as the JSON it always was, and indexed: every page is a
 * byte range of it. What has to hold is that nothing changes for anyone who
 * reads it whole — the JSON is exactly `JSON.stringify(model)` whichever
 * writer produced it — and that a reader taking one page, some pages or all of
 * them in turn gets exactly the pages the whole model holds. Then that each
 * server-side reader that stopped loading the model whole reaches the answer
 * it reached when it did.
 */

const ROOT = path.join(process.cwd(), ".anonify-storage", "documents")
const created: string[] = []

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64")
  // The smallest chunk configuration allows, so pages straddle chunks.
  process.env[CHUNK_SIZE_ENV] = "64KB"
})

afterAll(async () => {
  delete process.env[CHUNK_SIZE_ENV]
  await Promise.all(
    created.map((id) => rm(path.join(ROOT, id), { recursive: true, force: true }))
  )
})

function documentId(): string {
  const id = `doc_pages_${randomBytes(6).toString("hex")}`
  created.push(id)
  return id
}

function longText(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) =>
      `Line ${index}: John Smith of 12 Acacia Avenue, café 名前 🙂, ref ${index * 7}`
  ).join("\n")
}

async function modelsOfEveryShape(): Promise<NormalizedDocument[]> {
  const pdf = await makePdfFixture([
    [{ text: "Page one: John Smith" }],
    [{ text: "Page two: jane@example.com" }],
    [{ text: "Page three: 555-0100" }],
  ])
  return [
    extractText("t", utf8(longText(900))).document,
    extractText("t-empty", utf8("")).document,
    extractDelimited("c", "csv", utf8("name,email\nJohn,john@example.com\n")).document,
    (await extractPdf("p", pdf)).document,
    extractDocx("d", await makeLongDocxFixture(160, 40)).document,
    extractDocx("d2", await makeDocxFixture()).document,
    extractPptx("s", makePptxFixture()).document,
    extractEml("e", bytesOf(mixedEml())).document,
    extractEml("e2", bytesOf(quotedReplyEml())).document,
    extractRtf("r", utf8("{\\rtf1\\ansi John Smith\\par jane@example.com}")).document,
  ]
}

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"))
}

function slice(json: string, start: number, end: number): string {
  return Buffer.from(json, "utf8").subarray(start, end).toString("utf8")
}

describe("serializing an indexed model", () => {
  it("writes exactly JSON.stringify, and every page where the index says", async () => {
    for (const model of await modelsOfEveryShape()) {
      const { json, index } = serializeNormalized(model)

      expect(json).toBe(JSON.stringify(model))
      expect(index.size).toBe(Buffer.byteLength(json))
      expect(index.pages.map(([number]) => number)).toEqual(
        model.pages.map((page) => page.number)
      )
      for (const [position, [, start, end]] of index.pages.entries()) {
        expect(JSON.parse(slice(json, start, end))).toEqual(model.pages[position])
      }

      // Cutting the pages out leaves the outline.
      const outline = JSON.parse(
        slice(json, 0, index.open + 1) + slice(json, index.close, index.size)
      )
      expect(outline).toEqual({ ...model, pages: [] })
    }
  })

  it("leaves out a key whose value serializes to nothing, as JSON.stringify does", () => {
    const model = {
      documentId: "x",
      kind: "txt",
      language: undefined,
      pages: [],
      metadata: { a: undefined, b: 1 },
    } as unknown as NormalizedDocument
    expect(serializeNormalized(model).json).toBe(JSON.stringify(model))
  })
})

describe("the streaming extractors' index", () => {
  function streamed(
    extractor: { write(bytes: Uint8Array): string; end(): string },
    bytes: Uint8Array,
    size: number
  ): string {
    let json = ""
    for (let at = 0; at < bytes.byteLength; at += size) {
      json += extractor.write(bytes.subarray(at, at + size))
    }
    return json + extractor.end()
  }

  it("records what the whole-model serializer records, for text", () => {
    for (const size of [1, 7, 4096]) {
      const bytes = utf8(longText(400))
      const extractor = new TextExtractionStream("t")
      const json = streamed(extractor, bytes, size)
      const whole = serializeNormalized(extractText("t", bytes).document)

      expect(json).toBe(whole.json)
      expect(extractor.index).toEqual(whole.index)
    }
  })

  it("records the empty pages array of a grid", () => {
    const bytes = utf8("a,b\n1,2\n")
    const extractor = new DelimitedExtractionStream("c", "csv")
    const json = streamed(extractor, bytes, 3)
    const whole = serializeNormalized(extractDelimited("c", "csv", bytes).document)

    expect(json).toBe(whole.json)
    expect(extractor.index).toEqual(whole.index)
    expect(extractor.index.pages).toEqual([])
  })
})

describe("reading an index back", () => {
  const good: NormalizedIndex = {
    version: 1,
    size: 100,
    open: 10,
    close: 90,
    pages: [
      [1, 11, 40],
      [2, 41, 89],
    ],
  }

  it("accepts one that holds together", () => {
    expect(parseNormalizedIndex(good)).toEqual(good)
    expect(parseNormalizedIndex({ ...good, pages: [] })).toEqual({
      ...good,
      pages: [],
    })
  })

  it("treats a missing or incoherent one as absent, so the model is read whole", () => {
    for (const bad of [
      null,
      undefined,
      "index",
      { ...good, version: 2 },
      { ...good, open: 95 },
      { ...good, close: 100 },
      { ...good, pages: [[1, 50, 40]] },
      { ...good, pages: [[1, 5, 40]] },
      { ...good, pages: [[1, 11, 95]] },
      { ...good, pages: [[2, 41, 89], [1, 11, 40]] },
      { ...good, pages: [[1.5, 11, 40]] },
      { ...good, pages: [[1, 11]] },
      { ...good, size: -1 },
    ]) {
      expect(parseNormalizedIndex(bad)).toBeNull()
    }
  })
})

describe("a stored model, read a page at a time", () => {
  async function stored(
    model: NormalizedDocument,
    seal: DocumentSeal = newDocumentSeal()
  ) {
    const id = documentId()
    const saved = await saveNormalized(id, seal, { ...model, documentId: id })
    return {
      model: { ...model, documentId: id },
      indexed: openNormalized({ documentId: id, blobKey: saved.key, seal, index: saved.index }),
      unindexed: openNormalized({ documentId: id, blobKey: saved.key, seal, index: null }),
    }
  }

  async function all<T>(source: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = []
    for await (const item of source) out.push(item)
    return out
  }

  it("serves the same pages, outline and whole with an index as without, in both envelopes", async () => {
    const text = extractText("x", utf8(longText(3000))).document
    expect(text.pages.length).toBeGreaterThan(20)

    for (const format of ["v1", "v0"] as const) {
      const seal = { ...newDocumentSeal(), format }
      const { model, indexed, unindexed } = await stored(text, seal)
      expect(indexed.indexed).toBe(true)
      expect(unindexed.indexed).toBe(false)

      for (const reader of [indexed, unindexed]) {
        expect(await reader.whole()).toEqual(model)
        expect(await all(reader.pages())).toEqual(model.pages)
        expect(await all(reader.pages([3, 1, 17]))).toEqual([
          model.pages[0],
          model.pages[2],
          model.pages[16],
        ])
        expect(await reader.page(5)).toEqual(model.pages[4])
        expect(await reader.page(model.pages.length + 1)).toBeNull()

        const outline = await reader.outline()
        expect(outline.pageCount).toBe(model.pages.length)
        expect(outline.pageNumbers).toEqual(model.pages.map((page) => page.number))
        expect(withPages(outline, model.pages)).toEqual(model)
      }
    }
  })

  it("stops reading once the last indexed page has gone past", async () => {
    const { model, indexed } = await stored(
      extractText("x", utf8(longText(600))).document
    )
    const first: unknown[] = []
    for await (const page of indexed.pages()) {
      first.push(page)
      break
    }
    expect(first).toEqual([model.pages[0]])
  })

  it("refuses an index that points at the wrong page instead of serving it", async () => {
    const id = documentId()
    const seal = newDocumentSeal()
    const model = { ...extractText(id, utf8(longText(400))).document, documentId: id }
    const saved = await saveNormalized(id, seal, model)
    const [first, second] = saved.index.pages
    const swapped: NormalizedIndex = {
      ...saved.index,
      pages: [
        [first[0], second[1], second[2]],
        [second[0], first[1], first[2]],
        ...saved.index.pages.slice(2),
      ],
    }
    const reader = openNormalized({ documentId: id, blobKey: saved.key, seal, index: swapped })

    await expect(reader.page(1)).rejects.toThrow(/does not match/)
  })

  it("reads a model the streaming extractor wrote, by the extractor's index", async () => {
    const id = documentId()
    const seal = newDocumentSeal()
    const bytes = utf8(longText(2500))
    const extractor = new TextExtractionStream(id)

    async function* json() {
      for (let at = 0; at < bytes.byteLength; at += 5000) {
        yield Buffer.from(extractor.write(bytes.subarray(at, at + 5000)), "utf8")
      }
      yield Buffer.from(extractor.end(), "utf8")
    }

    const key = await saveNormalizedStream(id, seal, json())
    const reader = openNormalized({ documentId: id, blobKey: key, seal, index: extractor.index })
    const expected = extractText(id, bytes).document

    expect(await all(reader.pages())).toEqual(expected.pages)
    expect(await reader.page(expected.pages.length)).toEqual(expected.pages.at(-1))
  })

  it("gives analysis every page's text and none of its geometry", async () => {
    const pdf = await makePdfFixture([
      [{ text: "Page one: John Smith" }],
      [{ text: "Page two: jane@example.com" }],
    ])
    const { model, indexed } = await stored((await extractPdf("p", pdf)).document)
    const text = await loadTextModel(indexed)

    expect(text.pages.map((page) => page.text)).toEqual(model.pages.map((page) => page.text))
    expect(text.pages.map((page) => [page.number, page.width, page.height])).toEqual(
      model.pages.map((page) => [page.number, page.width, page.height])
    )
    expect(text.pages.every((page) => page.spans.length === 0)).toBe(true)
    expect(text.metadata).toEqual(model.metadata)
  })

  it("finds a rule's occurrences a page at a time exactly as over the whole model", async () => {
    for (const model of await modelsOfEveryShape()) {
      const { indexed } = await stored(model)
      for (const value of ["John Smith", "jane@example.com", "Line 1", "nowhere"]) {
        const options = { category: "person", confidence: 1, reason: "rule" }
        expect(await findOccurrencesIn(indexed, value, options)).toEqual(
          findAllOccurrences(model, value, options)
        )
      }
    }
  })
})

describe("an export that reads only the pages it redacts", () => {
  const OPTIONS = { addLabels: false, sanitizeMetadata: true }

  function redactionsOver(model: NormalizedDocument): Redaction[] {
    const redactions: Redaction[] = []
    for (const page of model.pages) {
      if (page.number % 3 !== 1 || page.text.length < 4) continue
      redactions.push({
        id: `r${page.number}`,
        documentId: model.documentId,
        type: "text",
        source: "user",
        category: "other",
        status: "accepted",
        page: page.number,
        start: 0,
        end: 4,
        text: page.text.slice(0, 4),
      })
    }
    // Decided against, so it must not pull its page in.
    redactions.push({
      id: "rejected",
      documentId: model.documentId,
      type: "text",
      source: "ai",
      category: "other",
      status: "rejected",
      page: 2,
      start: 0,
      end: 2,
      text: "xx",
    })
    return redactions
  }

  it("builds the same plan from those pages as from every page", async () => {
    for (const model of await modelsOfEveryShape()) {
      const redactions = redactionsOver(model)
      const wanted = pagesReadByExport(redactions, model.pages[0]?.number)
      const sparse = {
        ...model,
        pages: model.pages.filter((page) => wanted.has(page.number)),
      }
      expect(wanted.has(2) && model.pages.length > 2 && !redactions.some(
        (redaction) => redaction.status === "accepted" && redaction.page === 2
      )).toBe(false)

      const accepted = redactions.filter((redaction) => redaction.status === "accepted")
      for (const build of [buildDocxPlan, buildPdfPlan, buildTextPlan, buildEmlPlan]) {
        expect(JSON.stringify(build(sparse, accepted, OPTIONS))).toBe(
          JSON.stringify(build(model, accepted, OPTIONS))
        )
      }
    }
  })

  it("always includes the first page, which the image plan reads", () => {
    expect([...pagesReadByExport([], 1)]).toEqual([1])
    expect([...pagesReadByExport([], undefined)]).toEqual([])
  })
})

describe("the storage key a model is sealed under", () => {
  it("is the document's normalized path", () => {
    expect(normalizedKey("doc_x")).toBe("documents/doc_x/normalized.json.bin")
  })
})
