import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { extractXlsx } from "@/lib/documents/xlsx/extract"
import { redactXlsx } from "@/lib/documents/xlsx/redact"
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
