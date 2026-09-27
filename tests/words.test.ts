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

describe("a position inside a measured PDF run", () => {
  it("finds the character a horizontal position falls on", () => {
    const offsets = [0, 5, 10, 15, 20]
    expect(characterAtX(offsets, 0)).toBe(0)
    expect(characterAtX(offsets, 7)).toBe(1)
    expect(characterAtX(offsets, 19.9)).toBe(3)
    expect(characterAtX(offsets, 99)).toBe(3)
  })
})
