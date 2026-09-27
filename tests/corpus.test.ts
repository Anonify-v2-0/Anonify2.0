import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { int } from "@/benchmarks/corpus/lib/args"
import { createBackend } from "@/benchmarks/corpus/lib/backends"
import { buildDocument, countWords } from "@/benchmarks/corpus/lib/build"
import {
  fillPlaceholder,
  isValidIban,
  isValidVerhoeff,
  PLACEHOLDER_CATEGORY,
  type FillContext,
} from "@/benchmarks/corpus/lib/fill"
import {
  inferEntity,
  repairMarkup,
  stripMarkup,
} from "@/benchmarks/corpus/lib/markup"
import { denyTokens, findDenied } from "@/benchmarks/corpus/lib/operator"
import { createRng } from "@/benchmarks/corpus/lib/random"
import { documentPath, rebuild } from "@/benchmarks/corpus/lib/rebuild"
import {
  drawSpotCheck,
  nextReview,
  readReview,
  withMarkup,
  type Disagreement,
  type ReviewPass,
} from "@/benchmarks/corpus/lib/review"
import {
  isReservedEmail,
  isReservedPhone,
  isReservedUrl,
  isTestCard,
  scanForIdentifiers,
  TEST_CARD_NUMBERS,
  UNRESERVED_PHONE_LOCALES,
} from "@/benchmarks/corpus/lib/reserved"
import { CORPUS_SIZE, sampleSpecs } from "@/benchmarks/corpus/lib/spec"
import {
  LOCALES,
  type DocumentSpec,
  type Locale,
} from "@/benchmarks/corpus/lib/types"
import { checkDocument } from "@/benchmarks/corpus/lib/verify"
import { passesLuhn, plausibleSsn } from "@/lib/redaction/detectors"

function context(locale: Locale, seed = 1): FillContext {
  return {
    rng: createRng(seed, "test", locale),
    locale,
    cast: new Map([
      ["p1", "Dr. Priya Raman"],
      ["p2", "Jürgen Weiß"],
    ]),
    memo: new Map(),
  }
}

const GENERATOR = {
  backend: "test",
  model: "none",
  promptVersion: "1",
  seed: 57,
  attempt: 1,
  reviewedByHuman: false,
}

function spec(overrides: Partial<DocumentSpec> = {}): DocumentSpec {
  return {
    id: "syn-v1-0001",
    index: 0,
    split: "test",
    docType: "email thread",
    docTypeDetail: "support email thread, 2 messages",
    locale: "en-GB",
    length: "short",
    targetWords: 200,
    density: "low",
    cast: [{ id: "p1", role: "customer", mentions: 2 }],
    mustInclude: ["email"],
    negatives: ["an invoice number"],
    render: ["eml", "txt"],
    ...overrides,
  }
}

function response(body: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Your refund",
    docType: "support email thread",
    locale: "en-GB",
    cast: [{ id: "p1", name: "Priya Raman" }],
    body,
    negatives: ["INV-2291-07"],
    ...extra,
  })
}

const FILLER =
  "Thanks for getting in touch about the refund on your order. ".repeat(6)

describe("corpus spec sampler", () => {
  const specs = sampleSpecs(57)

  it("hits the issue's distributions exactly", () => {
    const count = (predicate: (s: DocumentSpec) => boolean) =>
      specs.filter(predicate).length
    expect(specs).toHaveLength(CORPUS_SIZE)
    expect(count((s) => s.split === "dev")).toBe(150)
    expect(count((s) => s.density === "none")).toBe(60)
    expect(count((s) => s.length === "short")).toBe(300)
    expect(count((s) => s.length === "long")).toBe(90)
    expect(count((s) => s.locale === "en-US")).toBe(270)
    expect(count((s) => s.locale === "en-GB")).toBe(150)
  })

  it("is stable for a seed and different across seeds", () => {
    expect(sampleSpecs(57)).toEqual(specs)
    expect(sampleSpecs(58).map((s) => s.docType)).not.toEqual(
      specs.map((s) => s.docType)
    )
  })

  it("gives documents with no PII no cast and no required categories", () => {
    for (const s of specs.filter((s) => s.density === "none")) {
      expect(s.cast).toEqual([])
      expect(s.mustInclude).toEqual([])
      expect(s.negatives.length).toBeGreaterThanOrEqual(3)
    }
  })
})

describe("corpus placeholder filler", () => {
  it("draws phone numbers from reserved ranges wherever one exists", () => {
    for (const locale of LOCALES) {
      const ctx = context(locale)
      for (let i = 0; i < 200; i++) {
        const value = fillPlaceholder("PHONE", undefined, ctx)
        const findings = scanForIdentifiers(`Tel: ${value}\n`)
        expect(
          findings.map((f) => f.kind),
          value
        ).toEqual(["phone"])
        expect(findings[0].value).toBe(value)
        if (!UNRESERVED_PHONE_LOCALES.includes(locale))
          expect(isReservedPhone(value), value).toBe(true)
      }
    }
  })

  it("writes emails and URLs only at reserved domains, and matches a person's name", () => {
    const ctx = context("en-GB")
    const email = fillPlaceholder("EMAIL", "p1", ctx)
    expect(isReservedEmail(email)).toBe(true)
    expect(email).toMatch(/priya|raman|^p\./)
    expect(fillPlaceholder("EMAIL", "p1", ctx)).toBe(email)
    expect(fillPlaceholder("EMAIL", "p2", ctx)).toMatch(/jurgen|weiss/)
    for (let i = 0; i < 200; i++) {
      expect(isReservedEmail(fillPlaceholder("EMAIL", undefined, ctx))).toBe(
        true
      )
      expect(isReservedUrl(fillPlaceholder("URL", undefined, ctx))).toBe(true)
    }
  })

  it("uses published test cards, which pass Luhn", () => {
    for (const card of TEST_CARD_NUMBERS)
      expect(passesLuhn(card), card).toBe(true)
    const ctx = context("en-US")
    for (let i = 0; i < 50; i++)
      expect(isTestCard(fillPlaceholder("CARD", undefined, ctx))).toBe(true)
  })

  it("makes checksum-valid IBANs and Aadhaar numbers", () => {
    for (const locale of LOCALES) {
      const ctx = context(locale)
      for (let i = 0; i < 50; i++)
        expect(isValidIban(fillPlaceholder("IBAN", undefined, ctx))).toBe(true)
    }
    const ctx = context("en-IN")
    for (let i = 0; i < 50; i++) {
      expect(
        isValidVerhoeff(
          fillPlaceholder("NATIONAL_ID", undefined, ctx).replace(/\s/g, "")
        )
      ).toBe(true)
    }
  })

  it("uses the SSA advertising block for SSNs and the QQ prefix for NI numbers", () => {
    const us = context("en-US")
    const gb = context("en-GB")
    for (let i = 0; i < 50; i++) {
      expect(
        fillPlaceholder("NATIONAL_ID", undefined, us).replace(/\D/g, "")
      ).toMatch(/^98765432\d$/)
      expect(fillPlaceholder("NATIONAL_ID", undefined, gb)).toMatch(
        /^QQ ?\d{2} ?\d{2} ?\d{2} ?[A-D]$/
      )
    }
    // Worth knowing when #59 reads the numbers: the deterministic detector
    // rejects area 9xx, so it will miss every reserved SSN in the corpus.
    expect(plausibleSsn("987-65-4321")).toBe(false)
  })

  it("is deterministic for a seed", () => {
    const a = context("fr-FR", 9)
    const b = context("fr-FR", 9)
    for (const name of Object.keys(PLACEHOLDER_CATEGORY)) {
      expect(fillPlaceholder(name, undefined, a)).toBe(
        fillPlaceholder(name, undefined, b)
      )
    }
  })
})

describe("corpus identifier scanner", () => {
  it("finds real-looking values and says whether they are reserved", () => {
    const text = [
      "Call 020 7946 0123 or 0161 496 0999, not 020 8123 4567.",
      "Mail priya@example.org, not priya@gmail.com.",
      "See https://www.example.com/profile and acme.com.",
      "From 203.0.113.9 and 8.8.8.8.",
      "US: (212) 555-0142 and (212) 867-5309.",
    ].join("\n")
    const found = scanForIdentifiers(text).map((f) => [
      f.kind,
      f.value,
      f.reserved,
    ])
    expect(found).toEqual([
      ["phone", "020 7946 0123", true],
      ["phone", "0161 496 0999", true],
      ["phone", "020 8123 4567", false],
      ["email", "priya@example.org", true],
      ["email", "priya@gmail.com", false],
      ["url", "https://www.example.com/profile", true],
      ["url", "acme.com", false],
      ["ip", "203.0.113.9", true],
      ["ip", "8.8.8.8", false],
      ["phone", "(212) 555-0142", true],
      ["phone", "(212) 867-5309", false],
    ])
  })

  it("reads IPv6 addresses whole, compressed or not", () => {
    for (const value of [
      "2001:4860:4860::8888",
      "2607:5300:0060:1234::1",
      "2001:4860:4860:0:0:0:0:8888",
      "2a03:2880:f10c:83::25de",
    ]) {
      expect(
        scanForIdentifiers(`Origin ${value} blocked.`).map((f) => [
          f.kind,
          f.value,
          f.reserved,
        ]),
        value
      ).toEqual([["ip", value, false]])
    }
    for (const value of ["2001:db8:1f::2a", "::1"]) {
      expect(
        scanForIdentifiers(`Origin ${value}.`).map((f) => [
          f.kind,
          f.value,
          f.reserved,
        ]),
        value
      ).toEqual([["ip", value, true]])
    }
  })

  it("does not take times, MAC addresses or scopes for IPv6", () => {
    const text =
      "At 10:30, 12:00:00 and 10:30:00; MAC 00:1a:2b:3c:4d:5e; std::vector, a :: b, Foo::Bar"
    expect(scanForIdentifiers(text)).toEqual([])
  })

  it("still judges the IPv4 part of a mapped address", () => {
    expect(
      scanForIdentifiers("From ::ffff:8.8.8.8 today").map((f) => [
        f.kind,
        f.value,
        f.reserved,
      ])
    ).toEqual([["ip", "8.8.8.8", false]])
  })

  it("does not take references, dates or amounts for phone numbers", () => {
    const text =
      "INV-2026-08543, TXN-938472847, ref 2026 08543, 2026-09-22, 12/03/1984, $1,250.00, SKU 4411-2290-118"
    expect(scanForIdentifiers(text)).toEqual([])
  })

  it("reads international forms of reserved numbers", () => {
    for (const value of [
      "+44 20 7946 0123",
      "+44 (0)161 496 0123",
      "+49 30 23125123",
      "+33 6 39 98 12 34",
      "+1 415 555 0100",
    ]) {
      expect(isReservedPhone(value), value).toBe(true)
    }
    expect(isReservedPhone("+44 20 8123 4567")).toBe(false)
  })
})

describe("corpus markup stripper", () => {
  it("strips markup and records exact offsets", () => {
    const { text, spans, errors } = stripMarkup(
      "Hi [[person|Priya]], call [[phone|{{PHONE}}]] or write to [[email|{{EMAIL:p1}}]].",
      context("en-GB")
    )
    expect(errors).toEqual([])
    expect(spans.map((s) => s.category)).toEqual(["person", "phone", "email"])
    for (const span of spans)
      expect(text.slice(span.start, span.end)).toBe(span.value)
    expect(spans[2].entity).toBe("p1")
    expect(spans[1].placeholder).toBe("PHONE")
    expect(text).not.toMatch(/\[\[|\]\]|\{\{/)
  })

  it("keeps whitespace inside the brackets out of the label", () => {
    const { text, spans } = stripMarkup(
      "Name:[[person| Priya ]]!",
      context("en-GB")
    )
    expect(text).toBe("Name: Priya !")
    expect(spans[0]).toMatchObject({ start: 6, end: 11, value: "Priya" })
  })

  it.each([
    ["[[person|Priya", "never closed"],
    ["Priya]] said", "no opening"],
    ["[[nickname|Pri]]", "unknown category"],
    ["[[Priya]]", "without a category"],
    ["[[person|[[person|Priya]]]]", "nested"],
    ["[[person|{{PHONE}}]]", 'expected "phone"'],
    ["call {{PHONE}}", "outside markup"],
    ["[[phone|{{FAX}}]]", "unknown placeholder"],
    ["[[phone|{{PHONE}]]", "malformed placeholder"],
    ["[[person|  ]]", "empty value"],
  ])("rejects %j", (body, message) => {
    const { errors } = stripMarkup(body, context("en-GB"))
    expect(errors.join("\n")).toContain(message)
  })

  it("attributes a name to a cast member in any of its forms", () => {
    const cast = new Map([
      ["p1", "Dr. Priya Raman"],
      ["p2", "Sanjay Raman"],
    ])
    expect(inferEntity("Priya", cast)).toBe("p1")
    expect(inferEntity("P. Raman", cast)).toBe("p1")
    expect(inferEntity("Priya Raman's", cast)).toBe("p1")
    expect(inferEntity("Ms Raman", cast)).toBeUndefined()
    expect(inferEntity("Nobody", cast)).toBeUndefined()
  })
})

describe("corpus document builder", () => {
  it("accepts a well-formed document and labels it by construction", () => {
    const result = buildDocument(
      spec(),
      response(
        `Dear [[person|Priya Raman]],\n\nInvoice INV-2291-07 is paid. ${FILLER}\nWe will write to [[email|{{EMAIL:p1}}]].\n\nRegards,\nSupport\nCC: [[person|Priya]]`
      ),
      GENERATOR
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    const { document } = result
    expect(document.spans.map((s) => [s.category, s.entity])).toEqual([
      ["person", "p1"],
      ["email", "p1"],
      ["person", "p1"],
    ])
    expect(document.negatives).toEqual([
      {
        start: expect.any(Number),
        end: expect.any(Number),
        value: "INV-2291-07",
      },
    ])
    expect(document.entities[0]).toMatchObject({
      id: "p1",
      requested: 2,
      mentions: 2,
    })
    expect(checkDocument(document)).toEqual([])
  })

  it.each([
    [
      "a real domain",
      "See acme.com for terms.",
      "url outside the reserved ranges",
    ],
    [
      "a phone number the model wrote",
      "Call [[phone|020 8123 4567]].",
      "phone outside the reserved ranges",
    ],
    [
      "a name labelled once and not again",
      "Priya called twice.",
      'unmarked repeat of "Priya"',
    ],
  ])("rejects %s", (_name, extra, reason) => {
    const result = buildDocument(
      spec(),
      response(
        `Dear [[person|Priya Raman]], ${FILLER} [[email|{{EMAIL:p1}}]]. ${extra}`
      ),
      GENERATOR
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons.join("\n")).toContain(reason)
  })

  it("rejects a document missing a required category or a cast member", () => {
    const result = buildDocument(
      spec({
        mustInclude: ["email", "api-key"],
        cast: [
          { id: "p1", role: "customer", mentions: 1 },
          { id: "p2", role: "agent", mentions: 1 },
        ],
      }),
      response(
        `Dear [[person|Priya Raman]], ${FILLER} [[email|{{EMAIL:p1}}]].`
      ),
      GENERATOR
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reasons).toContain('required category "api-key" is missing')
    expect(result.reasons).toContain(
      "cast member p2 is missing from the response's cast"
    )
  })

  it("rejects labels in a document that should have none", () => {
    const result = buildDocument(
      spec({ density: "none", cast: [], mustInclude: [] }),
      response(`Invoice INV-2291-07. ${FILLER} [[person|Priya]]`, { cast: [] }),
      GENERATOR
    )
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reasons.join("\n")).toContain(
        'density "none" but 1 labelled values'
      )
  })

  it("reads JSON wrapped in a code fence", () => {
    const fenced =
      "```json\n" +
      response(
        `Dear [[person|Priya Raman]], ${FILLER} [[email|{{EMAIL:p1}}]] [[person|Priya]].`
      ) +
      "\n```"
    expect(buildDocument(spec(), fenced, GENERATOR).ok).toBe(true)
  })

  it("counts CSV cells as words", () => {
    expect(countWords("id,name,plan\n1,Ada,Pro\n2,Lin,Basic")).toBe(9)
  })

  it("rejects a real address built onto a fill", () => {
    const result = buildDocument(
      spec(),
      response(
        `Dear [[person|Priya Raman]], ${FILLER} [[email|{{EMAIL:p1}}]]. Key: [[api-key|{{SECRET}}]]@gmail.com.`
      ),
      GENERATOR
    )
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reasons.join("\n")).toContain(
        "email outside the reserved ranges"
      )
  })
})

describe("corpus check", () => {
  function accepted() {
    const result = buildDocument(
      spec(),
      response(
        `Dear [[person|Priya Raman]], ${FILLER} [[email|{{EMAIL:p1}}]] [[person|Priya]].`
      ),
      GENERATOR
    )
    if (!result.ok) throw new Error(result.reasons.join("; "))
    return result.document
  }

  it("catches a real email pasted into a committed file", () => {
    const document = accepted()
    document.text += "\nForwarded from someone@gmail.com"
    expect(checkDocument(document).join("\n")).toContain(
      "email outside the reserved ranges"
    )
  })

  it("catches a label that no longer matches its text", () => {
    const document = accepted()
    document.text = `X${document.text}`
    expect(checkDocument(document).join("\n")).toContain(
      "but the text there is"
    )
  })

  it("allows a filled number in a locale with no reserved range, and nothing else", () => {
    const document = accepted()
    document.locale = "es-ES"
    const at = document.text.length + 1
    document.text += " 612 345 678"
    document.spans.push({
      start: at,
      end: at + 11,
      category: "phone",
      value: "612 345 678",
      placeholder: "PHONE",
    })
    expect(checkDocument(document)).toEqual([])
    delete document.spans[document.spans.length - 1].placeholder
    expect(checkDocument(document).join("\n")).toContain("labelled phone")
  })

  it("judges a value that a label only partly covers", () => {
    const document = accepted()
    const at = document.text.length + 13
    document.text += " Reach me at john.smith@gmail.com today"
    document.spans.push({
      start: at,
      end: at + 10,
      category: "email",
      value: "john.smith",
    })
    expect(checkDocument(document).join("\n")).toContain(
      `email outside the reserved ranges at ${at}: "john.smith@gmail.com"`
    )
  })

  it("judges an IP address labelled as other", () => {
    const document = accepted()
    const at = document.text.length + 8
    document.text += " Origin 93.184.216.34 blocked"
    document.spans.push({
      start: at,
      end: at + 13,
      category: "other",
      value: "93.184.216.34",
    })
    expect(checkDocument(document).join("\n")).toContain(
      `ip outside the reserved ranges at ${at}: "93.184.216.34"`
    )
    // Nor does claiming the script filled it in.
    document.spans[document.spans.length - 1].placeholder = "IP"
    expect(checkDocument(document).join("\n")).toContain(
      "ip outside the reserved ranges"
    )
  })
})

describe("corpus markup repair", () => {
  it.each([
    ["[[email|{{EMAIL}}}]", "[[email|{{EMAIL}}]]"],
    ["[[email|{{EMAIL:p1}}}}, next", "[[email|{{EMAIL:p1}}]], next"],
    ["[[phone|{{PHONE}}], next", "[[phone|{{PHONE}}]], next"],
    ["Tel,{{PHONE}},x", "Tel,[[phone|{{PHONE}}]],x"],
    [
      "[[email|{{EMAIL}}]] and {{GOV_ID:p1}}",
      "[[email|{{EMAIL}}]] and [[government-id|{{GOV_ID:p1}}]]",
    ],
  ])("repairs %j", (body, repaired) => {
    expect(repairMarkup(body)).toEqual({ body: repaired, repairs: 1 })
  })

  it.each([
    "[[email|{{EMAIL}}]]",
    "[[person|Priya]] and [[phone|ext {{PHONE}}]]",
    "{{FAX}} is not ours",
    "[[person|Priya]",
  ])("leaves %j alone", (body) => {
    expect(repairMarkup(body)).toEqual({ body, repairs: 0 })
  })
})

describe("corpus unmarked reserved values", () => {
  it("are labelled by their shape, even when the model called one a look-alike", () => {
    const result = buildDocument(
      spec(),
      response(
        `Dear [[person|Priya Raman]], ${FILLER} [[email|{{EMAIL:p1}}]] [[person|Priya]]. Copy to rajesh@example.com.`,
        { negatives: ["rajesh@example.com"] }
      ),
      GENERATOR
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const email = result.document.spans.find(
      (s) => s.value === "rajesh@example.com"
    )
    expect(email).toMatchObject({ category: "email" })
    expect(email?.placeholder).toBeUndefined()
    expect(result.document.negatives).toEqual([])
    expect(result.document.generator.markupRepairs).toBe(1)
    expect(checkDocument(result.document)).toEqual([])
  })
})

describe("corpus validator", () => {
  function accepted() {
    const result = buildDocument(
      spec(),
      response(
        `Dear [[person|Priya Raman]], Javier signed. ${FILLER} [[email|{{EMAIL:p1}}]] [[person|Priya]]. Invoice INV-2291-07.`
      ),
      GENERATOR
    )
    if (!result.ok) throw new Error(result.reasons.join("; "))
    return result.document
  }

  it("puts the labels back inline for the reviewer", () => {
    const document = accepted()
    expect(withMarkup(document)).toMatch(
      /^Dear \[\[person\|Priya Raman\]\], Javier signed\./
    )
    expect(withMarkup(document)).toContain("[[email|")
  })

  it("ties each claim to positions and drops claims about text that is not there", () => {
    const document = accepted()
    const review = readReview(
      document,
      JSON.stringify({
        missed: [
          { value: "Javier", category: "person", reason: "a signatory" },
          { value: "Nobody Here", category: "person", reason: "invented" },
        ],
        wrong: [
          {
            value: "Priya",
            labelled: "person",
            correct: "not-pii",
            reason: "test",
          },
          {
            value: "INV-2291-07",
            labelled: "customer-id",
            correct: "not-pii",
            reason: "not labelled at all",
          },
        ],
      })
    )
    expect(review.unlocated).toBe(2)
    expect(review.disagreements).toEqual([
      {
        kind: "missed",
        value: "Javier",
        category: "person",
        reason: "a signatory",
        at: [{ start: 18, end: 24 }],
      },
      {
        kind: "wrong",
        value: "Priya",
        labelled: "person",
        correct: "not-pii",
        reason: "test",
        at: [expect.any(Object)],
      },
    ])
  })
})

describe("corpus operator identity", () => {
  const tokens = denyTokens([
    "Ada Quill-Byron",
    "ada.quill@corp.test",
    "claude",
    "noreply@anthropic.com",
  ])

  it("takes whole emails and name-like parts, not generic ones", () => {
    expect(tokens).toEqual([
      "ada quill",
      "ada quill byron",
      "ada.quill@corp.test",
      "byron",
      "byron quill ada",
      "noreply@anthropic.com",
      "quill",
      "quill ada",
    ])
  })

  it("finds them as whole words in any case", () => {
    expect(findDenied("Signed, A. QUILL", tokens)).toEqual(["quill"])
    expect(findDenied("Quillon Ltd and Byronic verse", tokens)).toEqual([])
  })

  it("finds a whole name of short parts, in either order and however it is separated", () => {
    const short = denyTokens(["tom.lee@corp.test", "Li Wei"])
    expect(short).toEqual([
      "lee tom",
      "li wei",
      "tom lee",
      "tom.lee@corp.test",
      "wei li",
    ])
    expect(findDenied("Approved by Tom Lee.", short)).toEqual(["tom lee"])
    expect(findDenied("Approved by TOM  LEE", short)).toEqual(["tom lee"])
    expect(findDenied("Lee, Tom (approver)", short)).toEqual(["lee tom"])
    expect(findDenied("Assigned to Wei\nLi", short)).toEqual(["wei li"])
    expect(findDenied("Tom Leeds and Lee Tomlinson; Li Weiss", short)).toEqual(
      []
    )
    expect(findDenied("Tom, Ana and Lee", short)).toEqual([])
  })

  it("rejects a document that names an operator whose name parts are short", () => {
    const result = buildDocument(
      spec(),
      response(
        `Dear [[person|Priya Raman]], ${FILLER} [[email|{{EMAIL:p1}}]] [[person|Priya]]. Approved by Tom Lee.`
      ),
      GENERATOR,
      { deny: denyTokens(["tom.lee@corp.test"]) }
    )
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reasons).toContain(
        "mentions the operator's identity (to*****)"
      )
  })

  it("rejects a document that names the operator", () => {
    const result = buildDocument(
      spec(),
      response(
        `Dear [[person|Priya Raman]], ${FILLER} [[email|{{EMAIL:p1}}]] [[person|Priya]]. Approved by Quill.`
      ),
      GENERATOR,
      { deny: tokens }
    )
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reasons).toContain(
        "mentions the operator's identity (qu***)"
      )
  })
})

describe("corpus rebuild", () => {
  const deny = denyTokens(["Ada Quill"])
  const good = `Dear [[person|Priya Raman]], ${FILLER} [[email|{{EMAIL:p1}}]] [[person|Priya]].`
  const first = spec({ id: "syn-v1-0001", index: 0 })
  const second = spec({ id: "syn-v1-0002", index: 1 })
  let dir: string
  let out: string
  let responses: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "corpus-rebuild-"))
    out = path.join(dir, "synthetic-v1")
    responses = path.join(dir, "responses")
    await mkdir(responses, { recursive: true })
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  async function cache(id: string, attempt: number, body: string) {
    await writeFile(
      path.join(responses, `${id}.${attempt}.json`),
      JSON.stringify({
        ...GENERATOR,
        id,
        attempt,
        text: response(body),
        createdAt: "2026-01-01T00:00:00Z",
      })
    )
  }

  async function onDisk(target: DocumentSpec, body: string, reviewed = false) {
    const result = buildDocument(target, response(body), GENERATOR)
    if (!result.ok) throw new Error(result.reasons.join("; "))
    result.document.generator.reviewedByHuman = reviewed
    const file = documentPath(out, target)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(result.document))
    return file
  }

  const run = (specs: DocumentSpec[], lines: string[] = []) =>
    rebuild(specs, { out, responses, seed: 57, deny }, (line) =>
      lines.push(line)
    )

  it("re-derives a document from its first acceptable response", async () => {
    await cache(first.id, 1, `${good} Approved by Quill.`)
    await cache(first.id, 2, good)
    const summary = await run([first])
    expect(summary).toMatchObject({ written: 1, rejected: 0, removed: 0 })
    const written = JSON.parse(await readFile(documentPath(out, first), "utf8"))
    expect(written.generator.attempt).toBe(2)
  })

  it("removes a document the current checks now reject", async () => {
    // Written by an earlier run, before the operator's name was checked for.
    const file = await onDisk(first, `${good} Approved by Quill.`)
    await cache(first.id, 1, `${good} Approved by Quill.`)
    const lines: string[] = []
    const summary = await run([first], lines)
    expect(summary).toMatchObject({ written: 0, rejected: 1, removed: 1 })
    await expect(readFile(file)).rejects.toThrow()
    expect(lines.join("\n")).toContain("operator's identity (qu***)  (removed)")
  })

  it("leaves a reviewed document alone, and names it if it fails", async () => {
    const reviewed = await onDisk(first, good, true)
    const failing = await onDisk(second, `${good} Approved by Quill.`, true)
    const before = [await readFile(reviewed), await readFile(failing)]
    await cache(first.id, 1, good)
    await cache(second.id, 1, good)
    const lines: string[] = []
    const summary = await run([first, second], lines)
    expect(summary).toMatchObject({ written: 0, reviewed: 2 })
    expect(summary.failing).toEqual([second.id])
    expect([await readFile(reviewed), await readFile(failing)]).toEqual(before)
    expect(lines.join("\n")).toContain(
      `! ${second.id}  reviewed by a person, so kept, but the current checks reject it: mentions the operator's identity (qu***)`
    )
  })

  it("keeps a document it has no response for, and checks it", async () => {
    await onDisk(first, `${good} Approved by Quill.`)
    const summary = await run([first])
    expect(summary).toMatchObject({ uncached: 1, removed: 0 })
    expect(summary.failing).toEqual([first.id])
  })
})

describe("corpus command backend", () => {
  const backend = (command: string, timeoutMs = 10_000) =>
    createBackend({
      backend: "command",
      command,
      extraArgs: [],
      timeoutMs,
      thinkingTokens: 0,
    })
  const request = {
    system: "s".repeat(100_000),
    user: "u".repeat(100_000),
    schema: {},
  }

  it("returns what the command prints", async () => {
    const completion = await backend(
      `cat >/dev/null; echo '{"ok":1}'`
    ).complete(request)
    expect(completion.text.trim()).toBe(`{"ok":1}`)
  })

  it("reports a command that is not installed, rather than crashing on its input", async () => {
    // sh exits before reading 200 KB of prompt, so the write gets EPIPE.
    await expect(
      backend("corpus-no-such-command --flag").complete(request)
    ).rejects.toThrow(/exited with 127[\s\S]*not found on PATH/)
  })

  it("gives up on a command that outlives its timeout", async () => {
    const started = Date.now()
    await expect(
      backend("sleep 5; echo late", 200).complete(request)
    ).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe("corpus command-line numbers", () => {
  it("reads whole numbers", () => {
    expect(int("limit", "0")).toBe(0)
    expect(int("timeout", "600", 1)).toBe(600)
    expect(int("concurrency", " 4 ", 1)).toBe(4)
  })

  it.each([
    ["timeout", "10m", 1],
    ["concurrency", "x", 1],
    ["limit", "", 0],
    ["limit", "-1", 0],
    ["limit", "2.5", 0],
    ["timeout", "1e3", 1],
    ["concurrency", "0", 1],
    ["timeout", "0", 1],
  ])("refuses --%s %j", (name, value, min) => {
    expect(() => int(name, value, min)).toThrow(
      `--${name} must be a whole number`
    )
  })
})

describe("corpus review files", () => {
  const CODEX = { backend: "codex", model: "gpt-5-mini", promptVersion: "1" }
  const CLAUDE = {
    backend: "claude",
    model: "claude-haiku-4-5",
    promptVersion: "1",
  }

  function missed(value: string): Disagreement {
    return {
      kind: "missed",
      value,
      category: "person",
      reason: "a name",
      at: [{ start: 0, end: value.length }],
    }
  }

  function wrong(value: string): Disagreement {
    return {
      kind: "wrong",
      value,
      labelled: "person",
      correct: "not-pii",
      reason: "a company",
      at: [{ start: 10, end: 10 + value.length }],
    }
  }

  function pass(
    documentSha256: string,
    disagreements: Disagreement[],
    validator = CODEX
  ): ReviewPass {
    return {
      id: "syn-v1-0042",
      documentSha256,
      validator,
      validatedAt: "2026-09-27T00:00:00.000Z",
      disagreements,
    }
  }

  it("opens a review for a first disagreement, and writes nothing for none", () => {
    expect(nextReview(null, pass("a", []))).toMatchObject({
      review: null,
      write: false,
    })
    const outcome = nextReview(null, pass("a", [missed("Javier")]))
    expect(outcome.write).toBe(true)
    expect(outcome.review).toEqual({
      id: "syn-v1-0042",
      documentSha256: "a",
      validator: CODEX,
      status: "open",
      resolution: null,
      disagreements: [missed("Javier")],
    })
  })

  it("keeps a person's resolution when the validator repeats the claims they rejected", () => {
    const opened = nextReview(
      null,
      pass("a", [missed("Javier"), wrong("Acme Ltd")])
    ).review!
    // The person labels Javier, rejects the Acme claim, and settles it.
    const resolved = {
      ...opened,
      status: "resolved",
      resolution: "Labelled Javier. Acme Ltd is a company acting as one.",
    }
    // Their edit changed the file, so the next run validates it again.
    const outcome = nextReview(resolved, pass("b", [wrong("Acme Ltd")]))
    expect(outcome).toMatchObject({
      write: true,
      added: [],
      repeated: 1,
      reopened: false,
    })
    expect(outcome.review).toEqual({
      ...resolved,
      revalidations: [
        {
          documentSha256: "b",
          validator: CODEX,
          validatedAt: "2026-09-27T00:00:00.000Z",
          disagreements: [],
          repeated: [{ kind: "wrong", value: "Acme Ltd" }],
        },
      ],
    })
    // The same validator again on the same text adds nothing more.
    expect(
      nextReview(outcome.review, pass("b", [wrong("Acme Ltd")])).write
    ).toBe(false)
  })

  it("reopens a settled review for a claim nobody has seen, keeping its resolution", () => {
    const resolved = {
      ...nextReview(null, pass("a", [wrong("Acme Ltd")])).review!,
      status: "resolved",
      resolution: "Acme Ltd is a company.",
    }
    const outcome = nextReview(
      resolved,
      pass("a", [wrong("Acme Ltd"), missed("Rosa")], CLAUDE)
    )
    expect(outcome).toMatchObject({
      write: true,
      added: [missed("Rosa")],
      repeated: 1,
      reopened: true,
    })
    expect(outcome.review).toMatchObject({
      status: "open",
      resolution: "Acme Ltd is a company.",
      disagreements: [wrong("Acme Ltd")],
      revalidations: [
        {
          validator: CLAUDE,
          disagreements: [missed("Rosa")],
          repeated: [{ kind: "wrong", value: "Acme Ltd" }],
        },
      ],
    })
    // Rosa is now in the file: settling it again settles her too.
    const settled = { ...outcome.review!, status: "resolved" }
    expect(nextReview(settled, pass("c", [missed("Rosa")]))).toMatchObject({
      added: [],
      reopened: false,
      review: { status: "resolved" },
    })
  })

  it("adds a second validator's claims to an open review instead of replacing the first's", () => {
    const opened = nextReview(null, pass("a", [missed("Javier")])).review!
    const outcome = nextReview(
      opened,
      pass("a", [missed("Javier"), missed("Rosa")], CLAUDE)
    )
    expect(outcome.review).toMatchObject({
      status: "open",
      disagreements: [missed("Javier")],
      revalidations: [{ disagreements: [missed("Rosa")] }],
    })
  })

  it("starts again when nobody has touched a review of an older version", () => {
    const opened = nextReview(null, pass("a", [missed("Javier")])).review!
    expect(nextReview(opened, pass("b", [missed("Rosa")])).review).toEqual({
      ...opened,
      documentSha256: "b",
      disagreements: [missed("Rosa")],
    })
  })

  it("supersedes an open review of an older version once nothing is flagged", () => {
    const opened = nextReview(null, pass("a", [missed("Javier")])).review!
    const outcome = nextReview(opened, pass("b", []))
    expect(outcome).toMatchObject({ write: true, superseded: true })
    expect(outcome.review).toMatchObject({
      status: "superseded",
      disagreements: [missed("Javier")],
      revalidations: [
        {
          documentSha256: "b",
          disagreements: [],
          note: expect.stringContaining("changed"),
        },
      ],
    })
    // Not for the same text: a clean pass does not answer another's claims.
    expect(nextReview(opened, pass("a", [])).write).toBe(false)
    // And a settled review stays as the person left it.
    const resolved = { ...opened, status: "resolved" }
    expect(nextReview(resolved, pass("b", [])).write).toBe(false)
  })
})

describe("corpus spot-check", () => {
  const testIds = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => `syn-v1-${String(i + 1).padStart(4, "0")}`
    )

  it("draws a tenth of the test split", () => {
    const { spotCheck, added } = drawSpotCheck(
      "synthetic-v1",
      testIds(30),
      null
    )
    expect(spotCheck.ids).toHaveLength(3)
    expect(spotCheck.drawnFrom).toBe(30)
    expect(added).toEqual(spotCheck.ids)
  })

  it("tops the sample up as the split grows, keeping what was chosen and logged", () => {
    const first = drawSpotCheck("synthetic-v1", testIds(30), null).spotCheck
    const logged = {
      ...first,
      log: [
        {
          id: first.ids[0],
          reviewer: "a person",
          date: "2026-09-27",
          changed: "nothing",
        },
      ],
    }
    const { spotCheck, added } = drawSpotCheck(
      "synthetic-v1",
      testIds(450),
      logged
    )
    expect(spotCheck.ids).toHaveLength(45)
    expect(spotCheck.ids).toEqual(expect.arrayContaining(first.ids))
    expect(added).toHaveLength(42)
    expect(added.some((id) => first.ids.includes(id))).toBe(false)
    expect(new Set(spotCheck.ids).size).toBe(45)
    expect(spotCheck.drawnFrom).toBe(450)
    expect(spotCheck.log).toEqual(logged.log)
    // Deterministic, and settled once it covers the split.
    expect(
      drawSpotCheck("synthetic-v1", testIds(450), logged).spotCheck
    ).toEqual(spotCheck)
    expect(
      drawSpotCheck("synthetic-v1", testIds(450), spotCheck).spotCheck
    ).toBe(spotCheck)
  })

  it("tops up a file written before the split size was recorded", () => {
    const old = {
      note: "Checked by a person.",
      ids: ["syn-v1-0003", "syn-v1-0017", "syn-v1-0025"],
      log: [],
    }
    const { spotCheck } = drawSpotCheck("synthetic-v1", testIds(450), old)
    expect(spotCheck.ids).toHaveLength(45)
    expect(spotCheck.ids).toEqual(expect.arrayContaining(old.ids))
    expect(spotCheck.drawnFrom).toBe(450)
  })
})
