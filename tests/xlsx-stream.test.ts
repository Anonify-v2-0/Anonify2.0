import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"

import ExcelJS from "exceljs"
import { unzipSync, zipSync } from "fflate"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadNormalized, saveNormalizedStream } from "@/lib/documents/normalized-store"
import { sourceKey } from "@/lib/storage/blob"
import { newDocumentSeal, openSealedObject, putSealed } from "@/lib/storage/sealed"
import { cachedRangeSource } from "@/lib/storage/range-source"
import { CHUNK_SIZE_ENV } from "@/lib/storage/streaming"

import { openZip, ZipFallback } from "@/lib/documents/ooxml/zip"
import { extractXlsx } from "@/lib/documents/xlsx/extract"
import { XlsxExtractionStream } from "@/lib/documents/xlsx/stream"
import { bufferRangeSource } from "@/lib/storage/range-source"

import { makeSparseXlsxFixture, makeXlsxFixture } from "./fixtures"

/**
 * Workbooks streamed a sheet at a time, held to the whole-file extraction.
 *
 * The streamed path runs exceljs's own loader one worksheet at a time, so the
 * contract is the strictest one available: the JSON it writes is, character
 * for character, `JSON.stringify` of what the whole-file extractor returns —
 * for every cell type, every way a sheet can be hidden, merges, shared
 * formulas, dates, hyperlinks, and however the parts are ordered in the zip.
 */

async function streamed(bytes: Uint8Array, window = 4096) {
  const archive = await openZip(bufferRangeSource(bytes), window)
  const extractor = new XlsxExtractionStream("doc", archive)
  let json = ""
  for await (const piece of extractor.json()) json += piece
  return { json, cells: extractor.cellCount, index: extractor.index }
}

async function whole(bytes: Uint8Array) {
  const { document, cellCount } = await extractXlsx("doc", bytes)
  return { json: JSON.stringify(document), cells: cellCount }
}

async function outcome<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run()
  } catch (error) {
    return `threw: ${(error as Error).message}`
  }
}

async function expectSame(bytes: Uint8Array) {
  const expected = await outcome(() => whole(bytes))
  const actual = await outcome(async () => {
    const { json, cells } = await streamed(bytes)
    return { json, cells }
  })
  expect(actual).toEqual(expected)
}

async function write(workbook: ExcelJS.Workbook, options?: Partial<ExcelJS.XlsxWriteOptions>) {
  return new Uint8Array(await workbook.xlsx.writeBuffer(options))
}

/** Every kind of cell exceljs can write, over three sheets in a scrambled order. */
async function everything(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  workbook.title = "Quarterly"

  const people = workbook.addWorksheet("People")
  people.columns = [
    { header: "Name", key: "name", width: 20 },
    { header: "Email", key: "email" },
    { header: "Joined", key: "joined", style: { numFmt: "yyyy-mm-dd" } },
    { header: "Salary", key: "salary" },
  ]
  people.addRow({ name: "John Smith", email: "john@example.com", joined: new Date(Date.UTC(2020, 1, 3)), salary: 50000 })
  people.addRow({ name: "Jane Doe", email: { text: "jane@example.com", hyperlink: "mailto:jane@example.com" }, joined: new Date(Date.UTC(2021, 6, 9)), salary: 61000.5 })
  people.addRow({ name: { richText: [{ text: "Rich " }, { font: { bold: true }, text: "Text" }] }, email: true, joined: 45000, salary: { formula: "D2+D3", result: 111000.5 } })
  people.getCell("E2").value = { error: "#N/A" }
  people.getCell("E3").value = { formula: "D2*2", result: 100000 }
  people.getCell("E4").value = { sharedFormula: "E3", result: 122001 }
  people.getCell("F5").value = "far corner"
  people.getRow(3).hidden = true
  people.getColumn(2).hidden = true
  people.mergeCells("A7:C8")
  people.getCell("A7").value = "merged value"

  const hidden = workbook.addWorksheet("Secrets", { state: "hidden" })
  hidden.getCell("B2").value = "hidden sheet value"
  hidden.getCell("A1").value = null

  const veryHidden = workbook.addWorksheet("Deeper", { state: "veryHidden" })
  veryHidden.getCell("A1").value = "very hidden"
  veryHidden.getCell("C3").value = 3.14159

  const empty = workbook.addWorksheet("Empty")
  empty.getCell("D4").style = { font: { bold: true } }

  workbook.addWorksheet("Numbers").addRows(
    Array.from({ length: 300 }, (_, row) => [row, row * 1.5, `r${row}`, row % 2 === 0])
  )

  // Reorder so sheet order in the workbook is not creation order.
  // Not in exceljs's published types, and what the writer orders sheets by.
  ;(people as unknown as { orderNo: number }).orderNo = 3
  ;(hidden as unknown as { orderNo: number }).orderNo = 0
  return workbook
}

/** The same archive with its parts in another order. */
function reordered(bytes: Uint8Array, order: (names: string[]) => string[]): Uint8Array {
  const files = unzipSync(bytes)
  const out: Record<string, Uint8Array> = {}
  for (const name of order(Object.keys(files))) out[name] = files[name]
  return zipSync(out)
}

describe("streamed workbook extraction", () => {
  it("writes exactly what the whole-file extraction serializes, for the fixtures", async () => {
    await expectSame(await makeXlsxFixture())
    await expectSame(await makeSparseXlsxFixture())
  })

  it("writes exactly the same for every cell type, hidden state, merge and formula", async () => {
    const workbook = await everything()
    await expectSame(await write(workbook))
    await expectSame(await write(workbook, { useSharedStrings: false }))
    await expectSame(await write(workbook, { useStyles: false }))
  })

  it("does not depend on where the shared strings sit in the archive", async () => {
    const bytes = await write(await everything())
    const stringsLast = reordered(bytes, (names) => [
      ...names.filter((name) => !name.includes("sharedStrings")),
      ...names.filter((name) => name.includes("sharedStrings")),
    ])
    const reversed = reordered(bytes, (names) => [...names].reverse())
    await expectSame(stringsLast)
    await expectSame(reversed)
  })

  it("streams in any window, and counts the cells it wrote", async () => {
    const bytes = await write(await everything())
    const expected = await whole(bytes)
    for (const window of [97, 1 << 20]) {
      const { json, cells, index } = await streamed(bytes, window)
      expect(json).toBe(expected.json)
      expect(cells).toBe(expected.cells)
      expect(index.pages).toEqual([])
    }
  })

  it("is refused where the whole-file extraction refuses it", async () => {
    const workbook = new ExcelJS.Workbook()
    await expectSame(await write(workbook))

    const bytes = await write(await everything())
    const files = unzipSync(bytes)
    const broken = { ...files, "xl/worksheets/sheet1.xml": new TextEncoder().encode("<worksheet><sheetData><row") }
    await expectSame(zipSync(broken))
  })

  it("hands the workbook back to the whole-file path when a part is not UTF-8", async () => {
    const bytes = await write(await everything())
    const files = unzipSync(bytes)
    const xml = Buffer.from(files["xl/worksheets/sheet1.xml"])
    const bad = Buffer.concat([xml.subarray(0, 60), Buffer.from([0xff]), xml.subarray(60)])
    const archive = await openZip(bufferRangeSource(zipSync({ ...files, "xl/worksheets/sheet1.xml": bad })))
    const extractor = new XlsxExtractionStream("doc", archive)
    await expect(
      (async () => {
        for await (const piece of extractor.json()) void piece
      })()
    ).rejects.toBeInstanceOf(ZipFallback)
  })
})

describe("a workbook read by ranges out of sealed storage", () => {
  const id = `doc_xlsx_${randomBytes(6).toString("hex")}`

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64")
    process.env[CHUNK_SIZE_ENV] = "64KB"
  })

  afterAll(async () => {
    delete process.env[CHUNK_SIZE_ENV]
    await rm(path.join(process.cwd(), ".anonify-storage", "documents", id), {
      recursive: true,
      force: true,
    })
  })

  it("stores the model the whole-file extraction would have stored", async () => {
    const workbook = await everything()
    workbook.addWorksheet("Bulk").addRows(
      Array.from({ length: 12000 }, (_, row) => [`name ${row}`, row, randomBytes(8).toString("hex")])
    )
    const bytes = await write(workbook)
    expect(bytes.byteLength).toBeGreaterThan(3 * 64 * 1024)

    const seal = newDocumentSeal()
    const stored = await putSealed(sourceKey(id), bytes, seal)
    const object = await openSealedObject(stored.key, sourceKey(id), seal)
    const archive = await openZip(cachedRangeSource(object, 64 * 1024))
    const extractor = new XlsxExtractionStream(id, archive)

    async function* json() {
      for await (const piece of extractor.json()) yield Buffer.from(piece, "utf8")
    }
    const key = await saveNormalizedStream(id, seal, json())

    const { document } = await extractXlsx(id, bytes)
    expect(await loadNormalized(id, key, seal)).toEqual(document)
  })
})
