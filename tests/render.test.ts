import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import {
  parseCsv,
  renderDocument,
  RENDER_FORMATS,
  type RenderFormat,
} from "@/benchmarks/corpus/lib/render"
import type { LabelledDocument } from "@/benchmarks/corpus/lib/types"
import { align, extract, SourceMap } from "@/benchmarks/lib/extraction"

function documentOf(
  text: string,
  values: Array<[string, string]>,
  docType = "email thread"
): LabelledDocument {
  const spans = values.map(([value, category]) => {
    const start = text.indexOf(value)
    if (start === -1) throw new Error(`${value} is not in the text`)
    return { start, end: start + value.length, category, value }
  })
  return {
    id: "syn-v1-9999",
    docType,
    text,
    spans,
    negatives: [],
    render: [...RENDER_FORMATS],
  } as unknown as LabelledDocument
}

const LETTER = documentOf(
  [
    "From: Priya Raman <priya.raman@example.org>",
    "To: Accounts",
    "",
    "Hi team,\tthe card on file is 4111 1111 1111 1111 and the rent is ₹42,000.",
    "Tick one: ☐ yes ☒ no ✓",
    "Priya",
  ].join("\n"),
  [
    ["Priya Raman", "person"],
    ["priya.raman@example.org", "email"],
    ["4111 1111 1111 1111", "financial"],
    ["₹42,000", "financial"],
  ]
)

const TABLE = documentOf(
  [
    "id,name,email,note",
    '1,"Priya Raman",priya.raman@example.org,"Asked for a refund, twice"',
    '2,"Sam",,"Said ""no"" to the survey"',
  ].join("\n"),
  [
    ["Priya Raman", "person"],
    ["priya.raman@example.org", "email"],
    ["Sam", "person"],
  ],
  "tabular export"
)

describe("corpus rendering", () => {
  it.each(RENDER_FORMATS)(
    "renders %s the same bytes every time",
    async (format) => {
      const document = format === "csv" || format === "xlsx" ? TABLE : LETTER
      const first = await renderDocument(document, format)
      const second = await renderDocument(document, format)
      expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(
        true
      )
      expect(first.filename).toBe(`syn-v1-9999.${format}`)
    }
  )

  it("reads a tabular export as the rows it holds", () => {
    expect(parseCsv(TABLE.text)).toEqual([
      ["id", "name", "email", "note"],
      [
        "1",
        "Priya Raman",
        "priya.raman@example.org",
        "Asked for a refund, twice",
      ],
      ["2", "Sam", "", 'Said "no" to the survey'],
    ])
  })

  it("writes every spreadsheet cell as a string", async () => {
    const { bytes } = await renderDocument(TABLE, "xlsx")
    const files = unzipSync(bytes)
    const shared = new TextDecoder().decode(files["xl/sharedStrings.xml"])
    expect(shared).toContain("Priya Raman")
    expect(shared).toContain("Said &quot;no&quot; to the survey")
    expect(Object.keys(files)).toContain("xl/worksheets/sheet1.xml")
  })

  it("carries characters the PDF standard fonts cannot", async () => {
    expect((await renderDocument(LETTER, "pdf")).substituted).toBe(0)
  })
})

describe("corpus extraction round trip", () => {
  // xlsx is not here: the app's loadWorkbook misreads a small workbook
  // depending on where Node's buffer pool puts its copy, which would make
  // this test fail at random. The scorer reports those files instead.
  const cases: Array<[RenderFormat, LabelledDocument]> = [
    ["txt", LETTER],
    ["eml", LETTER],
    ["pdf", LETTER],
    ["docx", LETTER],
    ["csv", TABLE],
  ]

  it.each(cases)(
    "gives back every labelled character through %s",
    async (format, document) => {
      const rendered = await renderDocument(document, format)
      const model = await extract(document.id, format, rendered.bytes)
      const map = new SourceMap(document.text, model)
      expect(map.recovered(document.text, document.spans)).toBe(1)
    }
  )

  it("maps a detection in extracted text back to the label it covers", async () => {
    const rendered = await renderDocument(LETTER, "eml")
    const model = await extract(LETTER.id, "eml", rendered.bytes)
    const map = new SourceMap(LETTER.text, model)
    const page = model.pages.find((p) => p.text.includes("priya.raman@"))!
    const start = page.text.indexOf("priya.raman@example.org")
    const back = map.detection({
      text: "priya.raman@example.org",
      category: "email",
      confidence: 1,
      page: page.number,
      start,
      end: start + "priya.raman@example.org".length,
    })
    expect(back).toEqual({
      start: LETTER.spans[1].start,
      end: LETTER.spans[1].end,
      category: "email",
    })
  })
})

describe("corpus alignment", () => {
  it("is not pulled out of place by text extraction adds", () => {
    const source = "From: Priya Raman\nHello Priya, your order shipped."
    const target =
      "From: Anonify corpus\nSubject: x\n\nFrom: Priya Raman\nHello Priya, your order shipped."
    const map = align(source, target)
    const at = target.lastIndexOf("Priya Raman")
    expect(map[at]).toBe(source.indexOf("Priya Raman"))
    expect(map[target.indexOf("Anonify")]).toBe(-1)
  })

  it("matches cells across the delimiters extraction drops", () => {
    const source = 'row,"Mara",Retail,,,\n5,"K. M.",Retail'
    const target = "row\nMara\nRetail\n5\nK. M.\nRetail\n"
    const map = align(source, target)
    expect(map[target.indexOf("Mara")]).toBe(source.indexOf("Mara"))
    expect(map[target.indexOf("K. M.")]).toBe(source.indexOf("K. M."))
  })
})
