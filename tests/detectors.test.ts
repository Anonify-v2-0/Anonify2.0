import { describe, expect, it } from "vitest"

import {
  detectPatterns,
  passesLuhn,
  plausibleSsn,
  resolveOverlaps,
} from "@/lib/redaction/detectors"

function categories(text: string): string[] {
  return detectPatterns(text).map((detection) => detection.category)
}

describe("deterministic detectors", () => {
  it("finds email addresses", () => {
    const found = detectPatterns("Write to john.smith+tag@example.co.uk today.")
    expect(found).toHaveLength(1)
    expect(found[0].category).toBe("email")
    expect(found[0].text).toBe("john.smith+tag@example.co.uk")
    expect(found[0].global).toBe(true)
  })

  it("reports offsets that index back into the source text", () => {
    const text = "Contact: jane@example.com"
    const [detection] = detectPatterns(text)
    expect(text.slice(detection.start, detection.end)).toBe(detection.text)
  })

  it("finds phone numbers but ignores short digit runs", () => {
    expect(categories("Call +1 (415) 555-0132 now")).toContain("phone")
    expect(categories("Room 12 at 9am")).not.toContain("phone")
  })

  it("accepts a valid card number and rejects an invalid one", () => {
    expect(passesLuhn("4111 1111 1111 1111")).toBe(true)
    expect(passesLuhn("4111 1111 1111 1112")).toBe(false)
    expect(categories("Card 4111 1111 1111 1111")).toContain("financial")
    expect(categories("Order 4111 1111 1111 1112")).not.toContain("financial")
  })

  it("validates Social Security number structure", () => {
    expect(plausibleSsn("123-45-6789")).toBe(true)
    expect(plausibleSsn("000-45-6789")).toBe(false)
    expect(plausibleSsn("666-45-6789")).toBe(false)
    expect(plausibleSsn("123-00-6789")).toBe(false)
    expect(categories("SSN 123-45-6789")).toContain("government-id")
  })

  it("finds IBANs and labelled account numbers", () => {
    expect(categories("IBAN GB29NWBK60161331926819")).toContain("bank-account")
    expect(categories("Account: 12345678901")).toContain("bank-account")
    // The same digits with no label are not assumed to be an account.
    expect(categories("Batch 12345678901 shipped")).not.toContain("bank-account")
  })

  it("finds credentials", () => {
    expect(categories("key sk_live_abcdefghijklmnop1234")).toContain("api-key")
    expect(categories("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain(
      "api-key"
    )
    expect(categories("aws AKIAIOSFODNN7EXAMPLE")).toContain("api-key")
  })

  it("only treats a date as a birth date when it is labelled as one", () => {
    expect(categories("DOB: 04/12/1979")).toContain("date-of-birth")
    expect(categories("Invoice dated 04/12/1979")).not.toContain("date-of-birth")
  })

  it("only treats an identifier as a customer id when it is labelled", () => {
    expect(categories("Customer ID: ACME-88231")).toContain("customer-id")
    expect(categories("Part ACME-88231 in stock")).not.toContain("customer-id")
  })

  it("surfaces URLs that carry tokens, not ordinary links", () => {
    expect(categories("See https://example.com/reset/abc123")).toContain("url")
    expect(categories("See https://example.com/docs/intro")).not.toContain("url")
  })

  it("finds street addresses", () => {
    expect(categories("Ship to 1600 Amphitheatre Parkway Road")).toContain(
      "address"
    )
  })

  it("keeps the strongest detection when two overlap", () => {
    // A card number also matches the phone-number shape.
    const found = detectPatterns("Card 4111 1111 1111 1111 on file")
    const overlapping = found.filter(
      (detection) => detection.text.includes("4111")
    )
    expect(overlapping).toHaveLength(1)
    expect(overlapping[0].category).toBe("financial")
  })

  it("resolves overlaps in favour of higher confidence", () => {
    const resolved = resolveOverlaps([
      { text: "a", category: "low", confidence: 0.4, start: 0, end: 10 },
      { text: "b", category: "high", confidence: 0.9, start: 5, end: 15 },
    ])

    expect(resolved).toHaveLength(1)
    expect(resolved[0].category).toBe("high")
  })

  it("does not leak state between calls", () => {
    const text = "a@b.com and c@d.com"
    expect(detectPatterns(text)).toHaveLength(2)
    expect(detectPatterns(text)).toHaveLength(2)
  })

  it("applies a chunk offset to reported positions", () => {
    const [detection] = detectPatterns("jane@example.com", { offset: 100 })
    expect(detection.start).toBe(100)
    expect(detection.end).toBe(116)
  })
})
