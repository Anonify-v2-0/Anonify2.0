import { describe, expect, it } from "vitest"

import { learnPattern, learnShapes, signature } from "@/lib/assistant/learn"
import { compilePattern } from "@/lib/redaction/patterns"

/**
 * Hush learning a rule from the reviewer's hand-made redactions, locally.
 *
 * The property that matters most is the refusal: a shape with nothing to hold
 * on to — two capitalised words, a two-digit number — would become a rule
 * that redacts ordinary text, so it is never offered.
 */

function manual(text: string, category = "customer-id") {
  return { text, source: "user", status: "accepted", category, type: "text" }
}

describe("learning a pattern from alike values", () => {
  it("keeps what every example shares and generalises what varies", () => {
    expect(learnPattern(["EMP-00123", "EMP-00456", "EMP-00789"])).toEqual({
      spec: { kind: "regex", pattern: "EMP-00\\d{3}", matchCase: true, wholeWord: true },
      display: "EMP-00xxx",
    })
    expect(learnPattern(["MRN 4481923", "MRN 5519002"])?.spec.pattern).toBe("MRN\\s+\\d{7}")
    expect(learnPattern(["AB-1234-X", "CD-5678-Y"])?.spec.pattern).toBe("[A-Z]{2}-\\d{4}-[A-Z]")
    expect(learnPattern(["PRJ-Falcon", "PRJ-Hawk"])?.spec.pattern).toBe("PRJ-[A-Za-z]{4,6}")
  })

  it("offers nothing for a shape anchored to nothing", () => {
    expect(learnPattern(["John Smith", "Jane Doe", "Ann Lee"])).toBeNull()
    expect(learnPattern(["12", "34", "56"])).toBeNull()
    expect(learnPattern(["ab", "cd"])).toBeNull()
  })

  it("accepts a long enough number, which is an identifier rather than a quantity", () => {
    expect(learnPattern(["123-45-6789", "987-65-4321"])?.spec.pattern).toBe(
      "\\d{3}-\\d{2}-\\d{4}"
    )
  })

  it("only offers a pattern that matches every value it was learned from", () => {
    const values = ["EMP-00123", "EMP-00456", "EMP-00789"]
    const learned = learnPattern(values)
    const compiled = compilePattern(learned!.spec)
    for (const value of values) {
      expect(compiled.find(`id ${value}.`)).toHaveLength(1)
    }
    expect(compiled.find("EMP-00123456")).toHaveLength(0)
  })

  it("does not group values whose shapes differ", () => {
    expect(signature("EMP-00123")).not.toBe(signature("EMP_00123"))
    expect(learnPattern(["EMP-00123", "EMP_00456"])).toBeNull()
  })
})

describe("the shapes worth offering", () => {
  it("offers a rule once a shape has been redacted by hand three times", () => {
    const two = [manual("EMP-00123"), manual("EMP-00456")]
    expect(learnShapes(two)).toEqual([])

    const [shape] = learnShapes([...two, manual("EMP-00789", "other")])
    expect(shape.spec.pattern).toBe("EMP-00\\d{3}")
    expect(shape.examples).toEqual(["EMP-00123", "EMP-00456", "EMP-00789"])
    expect(shape.category).toBe("customer-id")
  })

  it("learns only from the reviewer's own text redactions", () => {
    const fromElsewhere = ["EMP-00123", "EMP-00456", "EMP-00789"].map((text) => ({
      ...manual(text),
      source: "ai",
    }))
    expect(learnShapes(fromElsewhere)).toEqual([])
    const rejected = ["EMP-00123", "EMP-00456", "EMP-00789"].map((text) => ({
      ...manual(text),
      status: "rejected",
    }))
    expect(learnShapes(rejected)).toEqual([])
  })

  it("does not offer a rule the reviewer already has", () => {
    const redactions = ["EMP-00123", "EMP-00456", "EMP-00789"].map((text) => manual(text))
    expect(learnShapes(redactions, { known: ["EMP-00\\d{3}"] })).toEqual([])
  })

  it("counts distinct values, not repeated clicks on one", () => {
    const redactions = [manual("EMP-00123"), manual("EMP-00123"), manual("EMP-00123")]
    expect(learnShapes(redactions)).toEqual([])
  })
})
