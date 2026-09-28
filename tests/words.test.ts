import { describe, expect, it } from "vitest"

import { characterAtX, wordAt } from "@/lib/redaction/words"

/**
 * What a click redacts. The unit is the value under the pointer, never the
 * span it sits in — a span is a whole line of a text file, and redacting the
 * line to remove one ID on it was the canvas's most common over-redaction.
 */

const LINE =
  "Line 1: Staff member EMP-10007 (Jane Doe) emailed jane.doe1@example.com about order ORDER-90001. Call +1 555 0100."

function clicked(text: string, target: string, at = 1): string | null {
  const offset = text.indexOf(target) + at
  const range = wordAt(text, offset)
  return range ? text.slice(range.start, range.end) : null
}

describe("the value under a click", () => {
  it("takes the whole identifier, email or name, and nothing around it", () => {
    expect(clicked(LINE, "EMP-10007")).toBe("EMP-10007")
    expect(clicked(LINE, "EMP-10007", 6)).toBe("EMP-10007")
    expect(clicked(LINE, "jane.doe1@example.com", 12)).toBe(
      "jane.doe1@example.com"
    )
    expect(clicked(LINE, "Doe")).toBe("Doe")
    expect(clicked(LINE, "Jane")).toBe("Jane")
  })

  it("leaves sentence punctuation outside the value", () => {
    expect(clicked(LINE, "ORDER-90001", 8)).toBe("ORDER-90001")
    expect(clicked("(O'Brien).", "O'Brien")).toBe("O'Brien")
  })

  it("takes the value to the left when the click lands just after it", () => {
    const offset = LINE.indexOf("EMP-10007") + "EMP-10007".length
    const range = wordAt(LINE, offset)
    expect(range && LINE.slice(range.start, range.end)).toBe("EMP-10007")
  })

  it("takes nothing from a space between words", () => {
    expect(wordAt("a  b", 2)).toBeNull()
    expect(wordAt("", 0)).toBeNull()
  })
})

describe("a value written with spaces in it", () => {
  // One group of these redacted leaves the rest of the value readable, so a
  // click takes the value, from wherever in it the click lands.
  const CARD = "Card 4111 1111 1111 1111 on file."
  const IBAN = "IBAN GB82 WEST 1234 5698 7654 32 for payroll."

  it("takes a whole card number", () => {
    for (const at of [1, 6, 16]) {
      expect(clicked(CARD, "4111 1111 1111 1111", at)).toBe(
        "4111 1111 1111 1111"
      )
    }
  })

  it("takes a whole IBAN written in groups, and not the label before it", () => {
    const value = "GB82 WEST 1234 5698 7654 32"
    for (const group of ["GB82", "WEST", "5698", "32"]) {
      expect(clicked(IBAN, group, 0)).toBe(value)
    }
    expect(clicked(IBAN, "IBAN")).toBe("IBAN")
    expect(clicked(IBAN, "payroll")).toBe("payroll")
  })

  it("takes a whole phone number, however it is grouped", () => {
    expect(clicked("Call +44 20 7946 0958 today", "7946")).toBe(
      "+44 20 7946 0958"
    )
    expect(clicked("Call (555) 123-4567 today", "123")).toBe("(555) 123-4567")
    expect(clicked("Call (555) 123-4567 today", "555")).toBe("(555) 123-4567")
    expect(clicked(LINE, "555 0100")).toBe("1 555 0100")
  })

  it("keeps a name, and a plain word, to the word clicked", () => {
    expect(clicked("Signed by Jane Doe today", "Jane")).toBe("Jane")
    expect(clicked("Signed by Jane Doe today", "Doe")).toBe("Doe")
    expect(clicked("I AM OK", "AM")).toBe("AM")
    expect(clicked("Page 3 of 10", "3", 0)).toBe("3")
  })

  it("does not join a row of figures into one value", () => {
    const row = "Totals 10 20 30 40 50 60 70 80 90 100 110 120 130 140 150"
    expect(clicked(row, "40", 0)).toBe("40")
  })
})

describe("a position inside a measured PDF run", () => {
  it("finds the character a horizontal position falls on", () => {
    const offsets = [0, 5, 10, 15, 20]
    expect(characterAtX(offsets, 0)).toBe(0)
    expect(characterAtX(offsets, 7)).toBe(1)
    expect(characterAtX(offsets, 19.9)).toBe(3)
    expect(characterAtX(offsets, 99)).toBe(3)
  })
})
