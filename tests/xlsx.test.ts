import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { newRedactionId } from "@/lib/documents/ids"
import { extractXlsx } from "@/lib/documents/xlsx/extract"
import { redactXlsx } from "@/lib/documents/xlsx/redact"
import { buildXlsxPlan } from "@/lib/redaction/apply"
import { verifyExport } from "@/lib/redaction/validation"
import type { Redaction } from "@/types/redaction"
import { makeXlsxFixture, SENSITIVE } from "./fixtures"

/** Everything a reader could pull out of the workbook's parts. */
function allXml(bytes: Uint8Array): string {
  const files = unzipSync(bytes)
  return Object.entries(files)
    .filter(([name]) => name.endsWith(".xml"))
    .map(([, content]) => Buffer.from(content).toString("utf8"))
    .join("\n")
}

describe("xlsx extraction", () => {
  it("reads worksheets, headers and cells", async () => {
    const bytes = await makeXlsxFixture()
    const { document } = await extractXlsx("doc_1", bytes)
    const sheets = document.sheets ?? []

    expect(document.kind).toBe("xlsx")
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Customers", "Archive"])
    expect(sheets[0].headers.slice(0, 4)).toEqual([
      "Name",
      "Email",
      "Account",
      "Amount",
    ])
  })

  it("keeps hidden rows and hidden sheets visible to the pipeline", async () => {
    const bytes = await makeXlsxFixture()
    const { document } = await extractXlsx("doc_1", bytes)
    const [customers, archive] = document.sheets ?? []

    expect(customers.hiddenRows).toContain(3)
    expect(archive.cells.some((cell) => cell.value === SENSITIVE.email)).toBe(true)
  })

  it("records which sheets the workbook hides", async () => {
    // The redactor treats every sheet alike, so this is carried purely for the
    // reviewer: a hidden sheet rendered exactly like a visible one is read as
    // ordinary content, and the decision made about it is the wrong one.
    const bytes = await makeXlsxFixture()
    const { document } = await extractXlsx("doc_1", bytes)
    const [customers, archive] = document.sheets ?? []

    expect(customers.visibility).toBeUndefined()
    expect(archive.visibility).toBe("hidden")
  })

  it("records formulas alongside values", async () => {
    const bytes = await makeXlsxFixture()
    const { document } = await extractXlsx("doc_1", bytes)
    const formulaCell = (document.sheets ?? [])[0].cells.find(
      (cell) => cell.formula
    )

    expect(formulaCell?.formula).toBe("B2")
  })
})

describe("xlsx redaction", () => {
  it("removes a single cell without touching its neighbours", async () => {
    const bytes = await makeXlsxFixture()
    const output = await redactXlsx(bytes, {
      cells: [{ sheet: "Customers", row: 2, column: 3 }],
      rows: [],
      columns: [],
      values: [SENSITIVE.account],
      label: null,
      sanitizeMetadata: false,
    })

    expect(allXml(output)).not.toContain(SENSITIVE.account)
    expect(allXml(output)).toContain("Account")
  })

  it("removes an entire column but keeps its header", async () => {
    const bytes = await makeXlsxFixture()
    const output = await redactXlsx(bytes, {
      cells: [],
      rows: [],
      columns: [{ sheet: "Customers", column: 2 }],
      values: [],
      label: null,
      sanitizeMetadata: false,
    })

    const { document } = await extractXlsx("doc_1", output)
    const customers = (document.sheets ?? [])[0]

    expect(customers.headers[1]).toBe("Email")
    const emails = customers.cells.filter(
      (cell) => cell.column === 2 && cell.row > 1
    )
    expect(emails.every((cell) => cell.value === null)).toBe(true)
  })

  it("removes an entire row", async () => {
    const bytes = await makeXlsxFixture()
    const output = await redactXlsx(bytes, {
      cells: [],
      rows: [{ sheet: "Customers", row: 3 }],
      columns: [],
      values: [],
      label: null,
      sanitizeMetadata: false,
    })

    expect(allXml(output)).not.toContain("jane@example.com")
    expect(allXml(output)).not.toContain("Jane Doe")
  })

  it("drops formulas that still reference a redacted cell", async () => {
    const bytes = await makeXlsxFixture()
    const output = await redactXlsx(bytes, {
      cells: [{ sheet: "Customers", row: 2, column: 2 }],
      rows: [],
      columns: [],
      values: [SENSITIVE.email],
      label: null,
      sanitizeMetadata: false,
    })

    const xml = allXml(output)
    expect(xml).not.toContain(SENSITIVE.email)
    expect(xml).not.toContain("<f>B2</f>")
  })

  it("reaches values hiding in a hidden sheet", async () => {
    const bytes = await makeXlsxFixture()
    const output = await redactXlsx(bytes, {
      cells: [],
      rows: [],
      columns: [],
      values: [SENSITIVE.person, SENSITIVE.email],
      label: null,
      sanitizeMetadata: false,
    })

    expect(allXml(output)).not.toContain(SENSITIVE.person)
    expect(allXml(output)).not.toContain(SENSITIVE.email)
  })

  it("writes a marker when one is requested", async () => {
    const bytes = await makeXlsxFixture()
    const output = await redactXlsx(bytes, {
      cells: [{ sheet: "Customers", row: 2, column: 1 }],
      rows: [],
      columns: [],
      values: [SENSITIVE.person],
      label: "[REDACTED]",
      sanitizeMetadata: false,
    })

    const { document } = await extractXlsx("doc_1", output)
    const cell = (document.sheets ?? [])[0].cells.find(
      (candidate) => candidate.row === 2 && candidate.column === 1
    )

    expect(cell?.value).toBe("[REDACTED]")
    expect(allXml(output)).not.toContain(SENSITIVE.person)
  })

  it("strips workbook authorship when asked", async () => {
    const bytes = await makeXlsxFixture()
    const output = await redactXlsx(bytes, {
      cells: [],
      rows: [],
      columns: [],
      values: [],
      label: null,
      sanitizeMetadata: true,
    })

    expect(allXml(output)).not.toContain("Test Author")
  })
})

describe("xlsx export verification", () => {
  /**
   * A column suggestion carries the column's *header* as its text, because that
   * is what a reviewer reads when deciding about it. Treating that header as a
   * value to sweep asked the exporter to remove a string it deliberately keeps,
   * and verification then found it still present and refused to deliver the
   * file. Every spreadsheet export failed the moment a column was accepted.
   */
  const columnRedaction = (
    sheet: string,
    column: number,
    header: string
  ): Redaction => ({
    id: newRedactionId(),
    documentId: "doc_1",
    type: "column",
    source: "ai",
    category: "other",
    status: "accepted",
    worksheet: sheet,
    column,
    text: header,
  })

  it("does not ask the export to remove a header it keeps on purpose", () => {
    const plan = buildXlsxPlan(
      [columnRedaction("Customers", 2, "Email")],
      { addLabels: false, sanitizeMetadata: false }
    )

    expect(plan.columns).toEqual([{ sheet: "Customers", column: 2 }])
    expect(plan.values).not.toContain("Email")
  })

  it("still sweeps the value a cell redaction carries", () => {
    const plan = buildXlsxPlan(
      [
        {
          id: newRedactionId(),
          documentId: "doc_1",
          type: "cell",
          source: "ai",
          category: "email",
          status: "accepted",
          worksheet: "Customers",
          row: 2,
          column: 2,
          text: SENSITIVE.email,
        },
      ],
      { addLabels: false, sanitizeMetadata: false }
    )

    expect(plan.values).toContain(SENSITIVE.email)
  })

  it("survives verification with a column accepted, end to end", async () => {
    const bytes = await makeXlsxFixture()
    const { document } = await extractXlsx("doc_1", bytes)
    const redactions = [
      columnRedaction("Customers", 2, "Email"),
      columnRedaction("Customers", 1, "Name"),
    ]

    const output = await redactXlsx(
      bytes,
      buildXlsxPlan(redactions, { addLabels: false, sanitizeMetadata: false })
    )

    const report = await verifyExport("xlsx", output, redactions)
    expect(report.leaked).toEqual([])
    expect(report.passed).toBe(true)

    // The column's data is gone and its name is not, which is the whole point.
    const [customers] = (await extractXlsx("doc_1", output)).document.sheets ?? []
    expect(customers.headers.slice(0, 2)).toEqual(["Name", "Email"])
    expect(
      customers.cells.filter((cell) => cell.column <= 2 && cell.row > 1)
    ).toEqual([])

    // The same email still exists on the hidden Archive sheet, because nothing
    // redacted it there. A column redaction removes a column, not a value —
    // reaching every copy is what a cell or text redaction is for, and this is
    // the distinction the export has to keep straight.
    expect(document.sheets?.[1].name).toBe("Archive")
    expect(allXml(output)).toContain(SENSITIVE.email)
  })
})
