import { describe, expect, it } from "vitest"

import {
  DELIMITED_SHEET_NAME,
  extractDelimited,
} from "@/lib/documents/delimited/extract"
import {
  DelimitedParseError,
  decodeText,
  parseDelimited,
  serializeDelimited,
  UTF8_BOM,
} from "@/lib/documents/delimited/parse"
import { redactDelimited } from "@/lib/documents/delimited/redact"
import { buildDelimitedPlan } from "@/lib/redaction/apply"
import { verifyExport } from "@/lib/redaction/validation"
import type { Redaction } from "@/types/redaction"

import { SENSITIVE } from "./fixtures"

/**
 * CSV and TSV.
 *
 * The whole risk in a delimited file is that the grid a redaction was
 * addressed against is not the grid the exporter reconstructs. Every fixture
 * below is a way that can happen: a comma inside a quoted field, a newline
 * inside one, a doubled quote, a ragged row. If the parse disagrees with
 * itself by one field, a redaction lands on the wrong cell and the value it
 * was supposed to remove ships.
 */

const encoder = new TextEncoder()

function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

function textOf(output: Uint8Array): string {
  return new TextDecoder().decode(output)
}

function cellRedaction(row: number, column: number, text: string): Redaction {
  return {
    id: `red-${row}-${column}`,
    documentId: "doc",
    type: "cell",
    source: "ai",
    category: "email",
    status: "accepted",
    worksheet: DELIMITED_SHEET_NAME,
    row,
    column,
    text,
  }
}

const OPTIONS = { addLabels: false, sanitizeMetadata: true }

describe("parsing delimited text", () => {
  it("keeps a delimiter that sits inside a quoted field", () => {
    const parsed = parseDelimited('a,"b,c",d\n', ",")

    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0].map((field) => field.value)).toEqual(["a", "b,c", "d"])
  })

  it("reads a doubled quote as one quote", () => {
    const parsed = parseDelimited('"she said ""hi""",next\n', ",")

    expect(parsed.rows[0][0].value).toBe('she said "hi"')
    expect(parsed.rows[0][1].value).toBe("next")
  })

  it("keeps a newline inside a quoted field in the same cell", () => {
    const parsed = parseDelimited('"line one\nline two",after\n', ",")

    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0][0].value).toBe("line one\nline two")
    expect(parsed.rows[0][1].value).toBe("after")
  })

  it("keeps empty cells rather than collapsing them", () => {
    const parsed = parseDelimited("a,,c\n", ",")

    expect(parsed.rows[0].map((field) => field.value)).toEqual(["a", "", "c"])
  })

  it("reads the last row of a file with no trailing newline", () => {
    const parsed = parseDelimited("a,b\nc,d", ",")

    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[1].map((field) => field.value)).toEqual(["c", "d"])
    expect(parsed.trailingNewline).toBe(false)
  })

  it("refuses a file whose quoted field is never closed", () => {
    // Guessing where the field ended would put every subsequent value in the
    // wrong column, which is how a redaction lands on the wrong cell.
    expect(() => parseDelimited('a,"unterminated\n', ",")).toThrow(
      DelimitedParseError
    )
  })

  it("splits on tabs for a TSV and leaves commas alone", () => {
    const parsed = parseDelimited("name\temail\nJohn, Jr.\tjohn@example.com\n", "\t")

    expect(parsed.rows[1].map((field) => field.value)).toEqual([
      "John, Jr.",
      "john@example.com",
    ])
  })

  describe("round trips", () => {
    it("reproduces a file it did not have to change", () => {
      const source = 'name,note\r\nJohn,"a, b"\r\n'
      expect(serializeDelimited(parseDelimited(source, ","))).toBe(source)
    })

    it("keeps the line ending the file used", () => {
      const parsed = parseDelimited("a,b\r\nc,d\r\n", ",")
      expect(parsed.eol).toBe("\r\n")
      expect(serializeDelimited(parsed)).toContain("\r\n")
    })

    it("keeps a byte-order mark", () => {
      const decoded = decodeText(bytes(`${UTF8_BOM}a,b\n`))
      expect(decoded.bom).toBe(true)

      const parsed = parseDelimited(decoded.text, ",", { bom: decoded.bom })
      expect(serializeDelimited(parsed).startsWith(UTF8_BOM)).toBe(true)
    })

    it("quotes a value that would otherwise change the shape of the grid", () => {
      const parsed = parseDelimited("a,b\n", ",")
      parsed.rows[0][0].value = "x,y"

      const round = parseDelimited(serializeDelimited(parsed), ",")
      expect(round.rows[0].map((field) => field.value)).toEqual(["x,y", "b"])
    })
  })

  it("refuses bytes that are not UTF-8 text", () => {
    expect(() => decodeText(new Uint8Array([0xff, 0xfe, 0x00, 0x41]))).toThrow(
      DelimitedParseError
    )
  })
})

describe("extracting a delimited file", () => {
  const csv = [
    "name,email,phone",
    `${SENSITIVE.person},${SENSITIVE.email},${SENSITIVE.phone}`,
    `Jane Doe,jane@example.com,`,
    `Repeat,${SENSITIVE.email},`,
    "",
  ].join("\n")

  it("normalizes to the worksheet model the grid review already speaks", () => {
    const { document } = extractDelimited("doc", "csv", bytes(csv))

    expect(document.kind).toBe("csv")
    expect(document.pages).toHaveLength(0)
    expect(document.sheets).toHaveLength(1)

    const sheet = document.sheets![0]
    expect(sheet.name).toBe(DELIMITED_SHEET_NAME)
    expect(sheet.headers).toEqual(["name", "email", "phone"])
    expect(sheet.rowCount).toBe(4)
    expect(sheet.columnCount).toBe(3)
  })

  it("gives every cell an address and skips the empty ones", () => {
    const { document } = extractDelimited("doc", "csv", bytes(csv))
    const cells = document.sheets![0].cells

    const email = cells.find(
      (cell) => cell.row === 2 && cell.column === 2
    )
    expect(email?.value).toBe(SENSITIVE.email)

    // Two blank trailing cells, which cost nothing to process and hold nothing.
    expect(cells.some((cell) => cell.value === "")).toBe(false)
    expect(cells).toHaveLength(3 + 3 + 2 + 2)
  })

  it("reads a TSV with the same model", () => {
    const tsv = `name\temail\n${SENSITIVE.person}\t${SENSITIVE.email}\n`
    const { document } = extractDelimited("doc", "tsv", bytes(tsv))

    expect(document.kind).toBe("tsv")
    expect(document.sheets![0].cells).toHaveLength(4)
    expect(
      document.sheets![0].cells.find(
        (cell) => cell.row === 2 && cell.column === 2
      )?.value
    ).toBe(SENSITIVE.email)
  })
})

describe("redacting a delimited file", () => {
  const csv = [
    "name,email,note",
    `${SENSITIVE.person},${SENSITIVE.email},"met at ${SENSITIVE.email}, twice"`,
    `Jane Doe,jane@example.com,fine`,
    "",
  ].join("\n")

  it("clears the addressed cell and nothing else", () => {
    const plan = buildDelimitedPlan(
      [cellRedaction(2, 2, SENSITIVE.email)],
      OPTIONS
    )
    const output = textOf(redactDelimited("csv", bytes(csv), plan))
    const parsed = parseDelimited(output, ",")

    expect(parsed.rows[1][1].value).toBe("")
    expect(parsed.rows[1][0].value).toBe(SENSITIVE.person)
    expect(parsed.rows[2][1].value).toBe("jane@example.com")
  })

  it("removes the accepted value from every other field it appears in", () => {
    const plan = buildDelimitedPlan(
      [cellRedaction(2, 2, SENSITIVE.email)],
      OPTIONS
    )
    const output = textOf(redactDelimited("csv", bytes(csv), plan))

    expect(output).not.toContain(SENSITIVE.email)
    // And the field that merely contained it keeps the rest of its text, with
    // its quoting intact so the row still has three fields.
    const parsed = parseDelimited(output, ",")
    expect(parsed.rows[1][2].value).toBe("met at , twice")
    expect(parsed.rows[1]).toHaveLength(3)
  })

  it("leaves the file parseable after a value is cut out of a quoted field", () => {
    // The sweep reaches a field nobody reviewed. Cutting characters out of the
    // middle of a quoted value is where a naive implementation breaks the row:
    // the commas around it are data, not delimiters.
    const source = `name,note\n${SENSITIVE.email},"a, ${SENSITIVE.email}, b"\n`
    const plan = buildDelimitedPlan(
      [cellRedaction(2, 1, SENSITIVE.email)],
      OPTIONS
    )

    const output = textOf(redactDelimited("csv", bytes(source), plan))
    const parsed = parseDelimited(output, ",")

    expect(parsed.rows[1]).toHaveLength(2)
    expect(parsed.rows[1][1].value).toBe("a, , b")
  })

  it("redacts a whole column but keeps its header", () => {
    const column: Redaction = {
      id: "col",
      documentId: "doc",
      type: "column",
      source: "ai",
      category: "email",
      status: "accepted",
      worksheet: DELIMITED_SHEET_NAME,
      column: 2,
      text: "email",
    }

    const output = textOf(
      redactDelimited("csv", bytes(csv), buildDelimitedPlan([column], OPTIONS))
    )
    const parsed = parseDelimited(output, ",")

    expect(parsed.rows[0][1].value).toBe("email")
    expect(parsed.rows[1][1].value).toBe("")
    expect(parsed.rows[2][1].value).toBe("")
  })

  it("writes the label when one was asked for", () => {
    const plan = buildDelimitedPlan([cellRedaction(2, 2, SENSITIVE.email)], {
      ...OPTIONS,
      addLabels: true,
    })
    const output = textOf(redactDelimited("csv", bytes(csv), plan))

    expect(output).toContain("[REDACTED]")
    expect(output).not.toContain(SENSITIVE.email)
  })

  it("ignores a rejected suggestion entirely", () => {
    const rejected: Redaction = {
      ...cellRedaction(2, 2, SENSITIVE.email),
      status: "rejected",
    }
    const output = textOf(
      redactDelimited("csv", bytes(csv), buildDelimitedPlan([rejected], OPTIONS))
    )

    expect(output).toContain(SENSITIVE.email)
  })

  describe("verification", () => {
    it("passes only once the value is gone from every parsed cell", async () => {
      const redaction = cellRedaction(2, 2, SENSITIVE.email)
      const output = redactDelimited(
        "csv",
        bytes(csv),
        buildDelimitedPlan([redaction], OPTIONS)
      )

      const report = await verifyExport("csv", output, [redaction])
      expect(report.passed).toBe(true)

      const untouched = await verifyExport("csv", bytes(csv), [redaction])
      expect(untouched.passed).toBe(false)
      expect(untouched.leaked).toContain(SENSITIVE.email)
    })
  })
})
