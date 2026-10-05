import { describe, expect, it } from "vitest"

import {
  detectPatterns,
  passesLuhn,
  plausibleSsn,
  resolveOverlaps,
} from "@/lib/redaction/detectors"
import type { Language } from "@/lib/redaction/languages"

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

  describe("phone numbers beside reference numbers (#203)", () => {
    const phones = (text: string, languages?: Language[]) =>
      detectPatterns(text, { languages })
        .filter((detection) => detection.category === "phone")
        .map(({ text, confidence }) => ({ text, confidence }))

    it("does not start inside a reference", () => {
      for (const text of [
        "Ref TXN-0098-4412-7700",
        "Factura n.º: ES-0048-7712-0906",
        "Invoice number: INV-000842-710395",
        "Die Referenz ist ÜW-2025-0514-7781",
        "processing reference: 1-884027-531004",
        "transaction reference: 40-21-09 00841726",
      ]) {
        expect(phones(text, ["en", "de", "fr", "es"]), text).toEqual([])
      }
    })

    it("still finds every locale's numbers", () => {
      const cases: Array<[string, string, Language[]]> = [
        ["Call +1 (415) 555-0132 now", "+1 (415) 555-0132", ["en"]],
        ["Support line 1-800-555-0148.", "1-800-555-0148", ["en"]],
        ["Requested a callback at 303-555-0147.", "303-555-0147", ["en"]],
        ["Telephone: 01632 960612", "01632 960612", ["en"]],
        ["Switchboard: 07700 900558", "07700 900558", ["en"]],
        ["Phone: +44 121 496 0786", "+44 121 496 0786", ["en"]],
        ["Telefon: 040/66969201", "040/66969201", ["de"]],
        ["Tel. +49 (0)40 66969 166", "+49 (0)40 66969 166", ["de"]],
        ["Tél. : 02 61 91 55 99", "02 61 91 55 99", ["fr"]],
        ["Téléphone : +33 1 99 00 15 77", "+33 1 99 00 15 77", ["fr"]],
        ["Teléfono: +34 912 345 678", "+34 912 345 678", ["es"]],
        ["customer,303-555-0147,open", "303-555-0147", ["en"]],
      ]
      for (const [text, number, languages] of cases) {
        expect(phones(text, languages), text).toEqual([
          { text: number, confidence: 0.88 },
        ])
      }
    })

    it("asks the model about a number after a document's own label", () => {
      const doubted = [
        ["Rechnungsnr.: 7000-4129-8841", "de"],
        ["Memo: reimbursement, ref. 4827-1906-5531", "en"],
        ["Invoice No.: 0000-4821-9635", "en"],
        ["Company registration no.: 84-7192630", "en"],
        ["Réf. opération : 0048 2719 6630", "fr"],
        ["Factura: 4827 1936 4402", "es"],
      ] as const
      for (const [text, language] of doubted) {
        const [found] = phones(text, [language])
        expect(found?.confidence, text).toBeLessThanOrEqual(0.75)
      }
      // A label for a person's number is not a reason to doubt it.
      expect(phones("Customer phone: 303-555-0147")).toEqual([
        { text: "303-555-0147", confidence: 0.88 },
      ])
    })
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
    expect(categories("Batch 12345678901 shipped")).not.toContain(
      "bank-account"
    )
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
    expect(categories("Invoice dated 04/12/1979")).not.toContain(
      "date-of-birth"
    )
  })

  it("only treats an identifier as a customer id when it is labelled", () => {
    expect(categories("Customer ID: ACME-88231")).toContain("customer-id")
    expect(categories("Part ACME-88231 in stock")).not.toContain("customer-id")
  })

  it("surfaces URLs that carry tokens, not ordinary links", () => {
    expect(categories("See https://example.com/reset/abc123")).toContain("url")
    expect(categories("See https://example.com/docs/intro")).not.toContain(
      "url"
    )
  })

  it("finds street addresses", () => {
    expect(categories("Ship to 1600 Amphitheatre Parkway Road")).toContain(
      "address"
    )
  })

  it("keeps the strongest detection when two overlap", () => {
    // A card number also matches the phone-number shape.
    const found = detectPatterns("Card 4111 1111 1111 1111 on file")
    const overlapping = found.filter((detection) =>
      detection.text.includes("4111")
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
