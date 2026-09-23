import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { scripted, type RecordedCall } from "./helpers/scripted-provider"
import type { ModelDetection } from "@/lib/ai/schemas/detection"
import type { NormalizedDocument, SpreadsheetSheet } from "@/types/document"
import type { Detection } from "@/types/redaction"

/**
 * `analyzeDocument`, end to end, against a provider that answers from a script.
 *
 * Every path through the orchestration wants a model, and CI has no key, so
 * until now none of it ran there. The scripted provider is a real AI SDK model
 * with the network taken out: the gateway, the throttle, structured output and
 * its schema validation all still run. What the script decides is only what
 * the model *says*; what the application does with it is the thing under test.
 */

const createUsage = vi.hoisted(() => vi.fn(async () => ({})))

vi.mock("@/lib/database/prisma", () => ({
  prisma: {
    aiUsage: {
      create: createUsage,
      groupBy: async () => [],
    },
  },
}))

vi.mock("@/lib/ai/providers", async (original) =>
  (await import("./helpers/scripted-provider")).scriptedProviders(original)
)

const { analyzeDocument, analyzeImageRegions, chunkPages } =
  await import("@/lib/ai/analyze")
const { resetThrottles } = await import("@/lib/services/throttle")
const { capabilityDeclaration } = await import("@/lib/ai/providers/config")
const { PRESETS } = await import("@/lib/redaction/presets")

function page(number: number, text: string) {
  return { number, width: 612, height: 792, text, spans: [] }
}

function doc(pages: ReturnType<typeof page>[]): NormalizedDocument {
  return { documentId: "doc_1", kind: "pdf", pages }
}

function found(
  text: string,
  overrides: Partial<ModelDetection> = {}
): ModelDetection {
  return {
    text,
    category: "person",
    confidence: 0.9,
    reason: "A named individual",
    global: false,
    ...overrides,
  }
}

/** A detect script that reports every match of a pattern in the chunk it is shown. */
function reportMatches(
  pattern: RegExp,
  overrides: Partial<ModelDetection> = {}
) {
  return (call: RecordedCall) => ({
    detections: [...call.content.matchAll(pattern)].map((match) =>
      found(match[0], overrides)
    ),
  })
}

function located(model: NormalizedDocument, detection: Detection): string {
  const text = model.pages.find((p) => p.number === detection.page)?.text ?? ""
  return text.slice(detection.start, detection.end)
}

let errors: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  scripted.reset()
  createUsage.mockClear()
  resetThrottles()

  // A default install: the Gateway, its default model, no spend cap, and the
  // service limits the application ships with.
  for (const name of [
    "AI_PROVIDER",
    "AI_MODEL",
    "AI_MODEL_CAPABILITIES",
    "ANONIFY_AI_DAILY_SPEND_USD",
    "ANONIFY_AI_CONCURRENCY",
    "ANONIFY_AI_REQUESTS_PER_MINUTE",
    "ANONIFY_AI_MAX_ATTEMPTS",
  ]) {
    vi.stubEnv(name, "")
  }

  errors = vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("the provider boundary", () => {
  it("asks for structured output and records what each call cost", async () => {
    scripted.setScript({ usage: { inputTokens: 120, outputTokens: 30 } })

    await analyzeDocument("doc_1", doc([page(1, "A short letter.")]))

    expect(scripted.calls.map((call) => call.task).sort()).toEqual([
      "classify",
      "detect",
    ])
    expect(scripted.calls.every((call) => call.jsonSchema)).toBe(true)

    expect(createUsage).toHaveBeenCalledTimes(2)
    expect(createUsage).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: "doc_1",
        task: "detect",
        model: "anthropic/claude-haiku-4.5",
        inputTokens: 120,
        outputTokens: 30,
      }),
    })
  })

  it("hands the classification to the detection prompt", async () => {
    scripted.setScript({
      classify: {
        documentType: "invoice",
        language: "English",
        sensitivityDensity: "medium",
        notes: "",
      },
    })

    const result = await analyzeDocument("doc_1", doc([page(1, "Invoice 42")]))

    expect(result.classification?.documentType).toBe("invoice")
    expect(scripted.callsFor("detect")[0].prompt).toContain(
      "Document type: invoice"
    )
  })
})

describe("chunking feeds the model", () => {
  it("asks once per chunk and maps every answer back to its page offset", async () => {
    const lines = (from: number) =>
      Array.from(
        { length: 400 },
        (_, i) =>
          `Line ${String(from + i).padStart(4, "0")} was signed by Alice Example-${String(from + i).padStart(4, "0")}.`
      ).join("\n")
    const model = doc([page(1, lines(0)), page(2, lines(400))])
    const chunks = chunkPages(model)
    expect(chunks.length).toBeGreaterThan(2)

    scripted.setScript({ detect: reportMatches(/Alice Example-\d{4}/g) })
    const { detections } = await analyzeDocument("doc_1", model)

    // One call per chunk, and each call was shown exactly one chunk.
    const shown = scripted.callsFor("detect").map((call) => call.content)
    expect(shown.sort()).toEqual(chunks.map((chunk) => chunk.text).sort())

    // Every name the model pointed at, on both pages, lands on its own text —
    // which only holds if each chunk's offset was added back.
    const people = detections.filter((d) => d.category === "person")
    expect(people).toHaveLength(800)
    for (const detection of people) {
      expect(located(model, detection)).toBe(detection.text)
    }
  })
})

describe("concurrency", () => {
  function manyPages(count: number) {
    return doc(
      Array.from({ length: count }, (_, i) =>
        page(i + 1, `Page ${i + 1} body.`)
      )
    )
  }

  it("keeps the configured number of calls in flight, and no more", async () => {
    scripted.setScript({ latencyMs: 20 })

    await analyzeDocument("doc_1", manyPages(12))

    expect(scripted.callsFor("detect")).toHaveLength(12)
    expect(scripted.peakInFlight).toBe(4)
  })

  it("shares the ceiling between documents processing at once", async () => {
    // It used to be applied per document, so two documents meant eight calls
    // in flight and the number the provider saw was one nobody had chosen.
    scripted.setScript({ latencyMs: 20 })

    await Promise.all([
      analyzeDocument("doc_1", manyPages(8)),
      analyzeDocument("doc_2", manyPages(8)),
    ])

    expect(scripted.callsFor("detect")).toHaveLength(16)
    expect(scripted.peakInFlight).toBe(4)
  })

  it("honours a lower ceiling from configuration", async () => {
    vi.stubEnv("ANONIFY_AI_CONCURRENCY", "2")
    scripted.setScript({ latencyMs: 20 })

    await analyzeDocument("doc_1", manyPages(8))

    expect(scripted.callsFor("detect")).toHaveLength(8)
    expect(scripted.peakInFlight).toBe(2)
  })
})

describe("the locate-or-discard rule", () => {
  // Invariant 5. The model returns text it claims to have seen; the application
  // finds that text itself, and what it cannot find is thrown away.
  const text = "Patient:  John\nSmith was admitted by Dr. Ada Park on Monday."
  const model = doc([page(1, text)])

  it("keeps a value that is in the source, at the source's position", async () => {
    scripted.setScript({ detect: { detections: [found("Ada Park")] } })

    const { detections } = await analyzeDocument("doc_1", model)

    const ada = detections.find((d) => d.text === "Ada Park")
    expect(ada).toMatchObject({ page: 1, start: text.indexOf("Ada Park") })
    expect(located(model, ada!)).toBe("Ada Park")
  })

  it("discards a value the model invented", async () => {
    scripted.setScript({
      detect: { detections: [found("Jane Doe"), found("Ada Park")] },
    })

    const { detections } = await analyzeDocument("doc_1", model)

    expect(detections.map((d) => d.text)).toContain("Ada Park")
    expect(detections.some((d) => /jane doe/i.test(d.text))).toBe(false)
  })

  it("keeps the source's spelling when the model normalized it", async () => {
    // The model collapsed a line break and changed the case. What reaches the
    // reviewer, and what export removes, is what is actually in the document.
    scripted.setScript({ detect: { detections: [found("john smith")] } })

    const { detections } = await analyzeDocument("doc_1", model)

    const john = detections.find((d) => d.category === "person")
    expect(john?.text).toBe("John\nSmith")
    expect(located(model, john!)).toBe("John\nSmith")
  })

  it("discards what the preset excludes even when the model proposes it", async () => {
    const preset = PRESETS.find((p) => p.id === "names-and-contact-details")!
    scripted.setScript({
      detect: {
        detections: [
          found("Ada Park"),
          found("Monday", { category: "date-of-birth" }),
        ],
      },
    })

    const { detections } = await analyzeDocument(
      "doc_1",
      model,
      undefined,
      preset
    )

    expect(detections.map((d) => d.text)).toEqual(["Ada Park"])
    expect(scripted.callsFor("detect")[0].prompt).toContain(
      "Report only these kinds of information"
    )
  })
})

describe("dedupe across paths", () => {
  it("turns a value found by a pattern and by the model into one suggestion", async () => {
    const model = doc([page(1, "Write to jane@example.com before Friday.")])
    scripted.setScript({
      detect: {
        detections: [
          found("jane@example.com", { category: "email", confidence: 0.8 }),
        ],
      },
    })

    const { detections } = await analyzeDocument("doc_1", model)

    // The model was told the pattern pass had it, and proposed it anyway.
    expect(scripted.callsFor("detect")[0].prompt).toContain(
      "- jane@example.com"
    )
    const emails = detections.filter((d) => d.text === "jane@example.com")
    expect(emails).toHaveLength(1)
    expect(emails[0].confidence).toBe(0.97)
  })
})

describe("global expansion", () => {
  it("finds the other occurrences locally rather than by asking again", async () => {
    const model = doc([
      page(1, "Contact Maria Lopez about the claim. Maria Lopez agreed."),
      page(2, "Signed, Maria Lopez."),
    ])
    scripted.setScript({
      detect: (call) => ({
        detections: call.content.startsWith("Contact")
          ? [found("Maria Lopez", { global: true })]
          : [],
      }),
    })

    const { detections } = await analyzeDocument("doc_1", model)

    const maria = detections.filter((d) => d.text === "Maria Lopez")
    expect(maria.map((d) => d.page)).toEqual([1, 1, 2])
    expect(maria.every((d) => d.global)).toBe(true)
    for (const detection of maria) {
      expect(located(model, detection)).toBe("Maria Lopez")
    }
    // Page two was shown to the model and it said nothing: the occurrence
    // there came from a string search.
    expect(scripted.callsFor("detect")).toHaveLength(2)
  })
})

describe("verifying shaky pattern hits", () => {
  const model = doc([
    page(1, "Ship to 12 Baker Street tomorrow. The office is 44 Elm Road."),
  ])

  it("applies the model's verdicts", async () => {
    scripted.setScript({
      verify: {
        verdicts: [
          {
            index: 0,
            sensitive: true,
            confidence: 0.95,
            reason: "A home address",
          },
          { index: 1, sensitive: false, confidence: 0.9, reason: "A business" },
        ],
      },
    })

    const { detections } = await analyzeDocument("doc_1", model)

    const addresses = detections.filter((d) => d.category === "address")
    expect(addresses).toHaveLength(1)
    expect(addresses[0]).toMatchObject({
      text: "12 Baker Street",
      confidence: 0.95,
      reason: "A home address",
    })
    // The model judged the candidate in context, not in isolation.
    expect(scripted.callsFor("verify")[0].prompt).toContain("Ship to 12 Baker")
  })

  it("leaves the candidates as the detector reported them when verification fails", async () => {
    scripted.setScript({ fail: { verify: { status: 401 } } })

    const { detections, degraded } = await analyzeDocument("doc_1", model)

    const addresses = detections.filter((d) => d.category === "address")
    expect(addresses.map((d) => d.confidence)).toEqual([0.6, 0.6])
    expect(degraded).toEqual({ reason: "authorization", calls: 1 })
  })
})

describe("provider failed, keep going", () => {
  const secret = "Ada Park lives at 12 Baker Street, ada@example.com"
  const model = doc([page(1, secret), page(2, "Second page about Ada Park.")])

  it("returns the pattern detections and says the model pass was cut short", async () => {
    scripted.setScript({ fail: { detect: { status: 402 } } })

    const result = await analyzeDocument("doc_1", model)

    expect(result.detections.map((d) => d.text)).toContain("ada@example.com")
    expect(result.degraded).toEqual({ reason: "budget", calls: 2 })
    // A failed call is not billed as though it ran.
    expect(createUsage).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ task: "detect" }),
    })
  })

  it("still detects when classification fails", async () => {
    scripted.setScript({
      fail: { classify: { status: 500 } },
      detect: { detections: [found("Ada Park")] },
    })
    vi.stubEnv("ANONIFY_AI_MAX_ATTEMPTS", "1")

    const result = await analyzeDocument("doc_1", model)

    expect(result.classification).toBeNull()
    expect(result.detections.filter((d) => d.text === "Ada Park")).toHaveLength(
      2
    )
    expect(result.degraded).toEqual({ reason: "provider", calls: 1 })
  })

  it("reports the most actionable reason, and every call lost", async () => {
    scripted.setScript({
      fail: {
        detect: (call) =>
          call.content.startsWith("Second")
            ? { status: 402 }
            : { status: 429, retryAfterSeconds: 0 },
      },
    })

    const result = await analyzeDocument("doc_1", model)

    // The rate limit was retried to the configured attempt count first.
    expect(scripted.callsFor("detect")).toHaveLength(4 + 1)
    expect(result.degraded).toEqual({ reason: "budget", calls: 2 })
  })

  it("uses the answer from a retry that succeeded", async () => {
    let refused = false
    scripted.setScript({
      fail: {
        detect: () => {
          if (refused) return null
          refused = true
          return { status: 429, retryAfterSeconds: 0 }
        },
      },
      detect: { detections: [found("Ada Park")] },
    })

    const result = await analyzeDocument("doc_1", doc([page(1, secret)]))

    expect(result.degraded).toBeNull()
    expect(result.detections.map((d) => d.text)).toContain("Ada Park")
  })

  it("treats output that is not JSON as no answer rather than an error", async () => {
    scripted.setScript({
      raw: { detect: "Sure! Here are the names: Ada Park" },
    })

    const result = await analyzeDocument("doc_1", model)

    expect(result.detections.some((d) => d.category === "person")).toBe(false)
    expect(result.degraded).toEqual({ reason: "invalid-output", calls: 2 })
  })

  it("rejects an answer that does not match the schema", async () => {
    scripted.setScript({
      detect: { detections: [found("Ada Park", { confidence: 7 })] },
    })

    const result = await analyzeDocument("doc_1", model)

    expect(result.detections.some((d) => d.text === "Ada Park")).toBe(false)
    expect(result.degraded).toEqual({ reason: "invalid-output", calls: 2 })
  })

  it("never writes document text into the failure log", async () => {
    scripted.setScript({
      fail: { detect: { status: 400, message: `Bad request: ${secret}` } },
    })

    await analyzeDocument("doc_1", model)

    expect(errors).toHaveBeenCalled()
    for (const [line] of errors.mock.calls) {
      expect(String(line)).not.toContain("Ada Park")
      expect(String(line)).not.toContain("Baker Street")
    }
  })
})

describe("spreadsheet columns", () => {
  function sheet(): SpreadsheetSheet {
    const headers = ["Name", "Email", "Notes", "Amount"]
    const rows = [
      ["Ada Park", "ada@example.com", "Called twice", "12.50"],
      ["Bo Chen", "bo@example.com", "", "8.00"],
    ]
    return {
      name: "Customers",
      rowCount: rows.length + 1,
      columnCount: headers.length,
      headers,
      cells: [headers, ...rows].flatMap((row, r) =>
        row.map((value, c) => ({
          row: r + 1,
          column: c + 1,
          value: value || null,
        }))
      ),
    }
  }

  it("keeps real columns under the sheet's own header and drops phantom ones", async () => {
    const model: NormalizedDocument = {
      documentId: "doc_1",
      kind: "xlsx",
      pages: [],
      sheets: [sheet()],
    }
    scripted.setScript({
      columns: {
        columns: [
          {
            index: 1,
            header: "Full name of the customer",
            category: "person",
            confidence: 0.9,
            sensitive: true,
            reason: "Customer names",
          },
          {
            index: 3,
            header: "Notes",
            category: "other",
            confidence: 0.4,
            sensitive: false,
            reason: "Free text",
          },
          {
            index: 8,
            header: "Social security",
            category: "government-id",
            confidence: 0.9,
            sensitive: true,
            reason: "A column that is not there",
          },
        ],
      },
    })

    const { sensitiveColumns } = await analyzeDocument("doc_1", model)

    expect(sensitiveColumns).toEqual([
      {
        worksheet: "Customers",
        column: 1,
        header: "Name",
        category: "person",
        confidence: 0.9,
        reason: "Customer names",
        filledRows: 2,
        totalRows: 2,
      },
    ])
    // The workbook has no pages, so it was classified from its headers.
    expect(scripted.callsFor("classify")[0].prompt).toContain(
      "Customers: Name, Email, Notes, Amount"
    )
  })
})

describe("the vision pass", () => {
  const image = {
    data: new Uint8Array([137, 80, 78, 71]),
    mediaType: "image/png",
  }
  const model: NormalizedDocument = {
    documentId: "doc_1",
    kind: "image",
    pages: [{ number: 1, width: 800, height: 600, text: "", spans: [] }],
  }

  it("sends the image to the model and scales its regions onto the page", async () => {
    scripted.setScript({
      image: {
        imageClass: "photograph",
        regions: [
          {
            kind: "face",
            category: "face",
            confidence: 0.92,
            reason: "A face",
            x: 250,
            y: 500,
            width: 100,
            height: 200,
          },
        ],
      },
    })

    const { regions, skipped } = await analyzeImageRegions(
      "doc_1",
      model,
      image
    )

    expect(skipped).toBeUndefined()
    expect(scripted.callsFor("image")[0].images).toEqual([
      { mediaType: "image/png" },
    ])
    expect(regions[0].boundingBox).toEqual({
      x: 200,
      y: 300,
      width: 80,
      height: 120,
    })
  })

  it("does not send an image to a model declared without vision", async () => {
    vi.stubEnv(
      "AI_MODEL_CAPABILITIES",
      capabilityDeclaration(process.env, {
        structuredOutput: true,
        vision: false,
      })
    )

    const result = await analyzeImageRegions("doc_1", model, image)

    expect(result).toEqual({ regions: [], skipped: "unsupported" })
    expect(scripted.calls).toHaveLength(0)
  })
})
