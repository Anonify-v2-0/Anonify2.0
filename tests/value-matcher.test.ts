import { describe, expect, it } from "vitest"

import {
  findOccurrences,
  mergeRanges,
  valueMatcher,
  type CharRange,
} from "@/lib/documents/shared/text"

/**
 * The safety sweep's search.
 *
 * It replaced a loop over the values inside a loop over the document, which
 * was correct and quadratic. Correctness is therefore the first thing to pin,
 * and it is pinned against the implementation it replaced: whatever the old
 * per-value search would have found and merged, this must find too.
 *
 * The scale test at the end is the reason any of this exists. It is written as
 * a wall-clock bound rather than a complexity assertion because that is the
 * thing that actually went wrong — a 1.5 MB export taking forty seconds.
 */

function rangesFor(haystack: string, values: string[]): CharRange[] {
  return mergeRanges(valueMatcher(values).find(haystack))
}

/** What the per-value search would have produced, merged the same way. */
function reference(haystack: string, values: string[]): CharRange[] {
  return mergeRanges(
    values.flatMap((value) => findOccurrences(haystack, value))
  )
}

function covered(haystack: string, ranges: CharRange[]): string[] {
  return ranges.map((range) => haystack.slice(range.start, range.end))
}

describe("matching many values at once", () => {
  it("finds every value in one pass", () => {
    const haystack = "Call John Smith on +1 (415) 555-0132 or john@example.com."
    const values = ["John Smith", "john@example.com", "+1 (415) 555-0132"]

    expect(covered(haystack, rangesFor(haystack, values)).sort()).toEqual(
      [...values].sort()
    )
  })

  it("matches without regard to case", () => {
    const haystack = "Write to JOHN@EXAMPLE.COM today"
    expect(covered(haystack, rangesFor(haystack, ["john@example.com"]))).toEqual(
      ["JOHN@EXAMPLE.COM"]
    )
  })

  it("finds every occurrence, not only the first", () => {
    const haystack = "a@b.com then a@b.com then a@b.com"
    expect(rangesFor(haystack, ["a@b.com"])).toHaveLength(3)
  })

  it("finds a value that is a suffix of another", () => {
    // The failure-link case: "example.com" ends inside "john@example.com", and
    // a trie without failure links reports only the longer one.
    const haystack = "mail john@example.com or visit example.com"
    const ranges = rangesFor(haystack, ["john@example.com", "example.com"])

    expect(covered(haystack, ranges)).toEqual([
      "john@example.com",
      "example.com",
    ])
  })

  it("finds a value that is a prefix of another", () => {
    const haystack = "John and John Smith"
    const ranges = rangesFor(haystack, ["John", "John Smith"])

    expect(covered(haystack, ranges)).toEqual(["John", "John Smith"])
  })

  it("merges values that overlap in the text", () => {
    const haystack = "abcdef"
    expect(rangesFor(haystack, ["abcd", "cdef"])).toEqual([
      { start: 0, end: 6 },
    ])
  })

  it("finds nothing when there is nothing to find", () => {
    expect(rangesFor("nothing here", ["absent"])).toEqual([])
    expect(rangesFor("", ["absent"])).toEqual([])
  })

  it("compiles nothing from an empty or blank list", () => {
    expect(valueMatcher([]).size).toBe(0)
    expect(valueMatcher([""]).size).toBe(0)
    expect(rangesFor("anything at all", [])).toEqual([])
  })

  it("counts distinct values once, however they were cased", () => {
    expect(valueMatcher(["a@b.com", "A@B.COM", "c@d.com"]).size).toBe(2)
  })

  describe("agreement with the search it replaced", () => {
    const haystack = [
      "Name: John Smith",
      "Email: john@example.com and JOHN@EXAMPLE.COM",
      "Phone: +1 (415) 555-0132",
      "Repeat: john@example.com",
      "Domain: example.com",
      "Nothing sensitive on this line at all.",
    ].join("\n")

    const values = [
      "john@example.com",
      "John Smith",
      "+1 (415) 555-0132",
      "example.com",
      "absent@example.com",
    ]

    it("covers the same characters", () => {
      expect(rangesFor(haystack, values)).toEqual(reference(haystack, values))
    })

    it("covers the same characters one value at a time", () => {
      for (const value of values) {
        expect(rangesFor(haystack, [value])).toEqual(
          reference(haystack, [value])
        )
      }
    })
  })

  describe("scale", () => {
    it("stays linear in the text rather than the values", () => {
      // The shape that broke: every row of a grid holding a *different*
      // address, so the value list is as long as the document. Searched one
      // value at a time this is twenty million string scans.
      const values = Array.from(
        { length: 5_000 },
        (_unused, index) => `user${index}@example.com`
      )
      const haystack = values
        .map((value, index) => `row ${index}: ${value} — some trailing prose`)
        .join("\n")

      const started = Date.now()
      const matcher = valueMatcher(values)
      const ranges = mergeRanges(matcher.find(haystack))
      const elapsed = Date.now() - started

      expect(matcher.size).toBe(5_000)
      expect(ranges).toHaveLength(5_000)
      // Generous by two orders of magnitude against the quadratic version,
      // which took tens of seconds for this shape.
      expect(elapsed).toBeLessThan(3_000)
    })
  })
})
