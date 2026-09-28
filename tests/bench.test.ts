import { describe, expect, it } from "vitest"

import type { LabelledDocument } from "@/benchmarks/corpus/lib/types"
import {
  addedByExpansion,
  attribute,
  BENCH_SCHEMA,
  costOf,
  expansionByRepeat,
  modelSlug,
  parseModels,
  repeatRate,
  serialise,
  summarise,
  throughputPoint,
  toRecord,
  type DocumentRecord,
  type ModelResults,
} from "@/benchmarks/lib/bench"
import type { Passes } from "@/benchmarks/lib/pipeline"
import {
  benchmarksMarkdown,
  buildReport,
  MARKERS,
  money,
  replaceSection,
  rootMarkdown,
} from "@/benchmarks/lib/report"
import { DARK, LIGHT, paretoFrontier, wrap } from "@/benchmarks/lib/svg"
import { detectPatterns } from "@/lib/redaction/detectors"

// "Priya Raman" at 5-16, 555-0142 at 20-28, "Priya" again at 39-44.
const TEXT = "Call Priya Raman on 555-0142. Thanks, Priya."
const NAME = { start: 5, end: 16, category: "person" }
const PHONE = { start: 20, end: 28, category: "phone" }
const REPEAT = { start: 38, end: 43, category: "person" }

function document(
  id: string,
  extra: Partial<LabelledDocument> = {}
): LabelledDocument {
  return {
    id,
    split: "test",
    title: id,
    docType: "email thread",
    docTypeDetail: "email thread",
    locale: "en-GB",
    length: "short",
    density: "medium",
    render: ["eml"],
    words: 7,
    text: TEXT,
    spans: [
      { ...NAME, value: "Priya Raman" },
      { ...PHONE, value: "555-0142" },
      { ...REPEAT, value: "Priya" },
    ],
    negatives: [],
    entities: [
      {
        id: "p1",
        name: "Priya Raman",
        role: "customer",
        requested: 2,
        mentions: 2,
      },
    ],
    spec: { mustInclude: [], negatives: [], targetWords: 7 },
    generator: {
      backend: "test",
      model: "test",
      promptVersion: "1",
      seed: 1,
      attempt: 1,
      markupRepairs: 0,
      reviewedByHuman: false,
    },
    ...extra,
  } as LabelledDocument
}

function record(
  doc: LabelledDocument,
  passes: Partial<Passes>,
  tokens = { input: 1000, output: 100 }
): DocumentRecord {
  const full: Passes = {
    patterns: [],
    rejected: 0,
    model: [],
    expanded: [],
    ...passes,
  }
  return toRecord(
    doc,
    {
      detections: [...full.patterns, ...full.model, ...full.expanded],
      passes: full,
      degraded: null,
      timings: { extractMs: null, analyzeMs: 1200.4, exportMs: null },
    },
    {
      calls: 2,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      durationMs: 900,
      byTask: {
        detect: {
          calls: 2,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          durationMs: 900,
        },
      },
    }
  )
}

describe("the models to benchmark", () => {
  it("reads provider:model pairs, labels, and model ids with colons of their own", () => {
    expect(
      parseModels(
        "gateway:anthropic/claude-haiku-4.5=Haiku 4.5, openai:gpt-5-mini\nollama:llama3.1:8b"
      )
    ).toEqual([
      {
        provider: "gateway",
        model: "anthropic/claude-haiku-4.5",
        label: "Haiku 4.5",
      },
      { provider: "openai", model: "gpt-5-mini", label: "gpt-5-mini" },
      { provider: "ollama", model: "llama3.1:8b", label: "llama3.1:8b" },
    ])
  })

  it("takes an entry with no provider as a gateway model, and refuses an empty one", () => {
    expect(parseModels("anthropic/claude-sonnet-4.5")).toEqual([
      {
        provider: "gateway",
        model: "anthropic/claude-sonnet-4.5",
        label: "anthropic/claude-sonnet-4.5",
      },
    ])
    expect(() => parseModels("openai:")).toThrow(/not provider:model/)
  })

  it("names a results file safely on every filesystem", () => {
    expect(modelSlug("anthropic/claude-haiku-4.5")).toBe(
      "anthropic_claude-haiku-4.5"
    )
    expect(modelSlug("ollama:llama3.1:8b")).toBe("ollama_llama3.1_8b")
  })
})

describe("the model-only preset", () => {
  it("runs no pattern at all, where no preset runs every one", () => {
    const text = "Mail jane@example.com or call 555-0142."
    expect(detectPatterns(text, { detectors: [] })).toEqual([])
    expect(detectPatterns(text, {}).length).toBeGreaterThan(0)
  })
})

describe("where the result comes from", () => {
  it("credits each covered label to the first pass that covers it alone", () => {
    const doc = document("a")
    const r = record(doc, {
      patterns: [PHONE],
      model: [NAME],
      expanded: [NAME, REPEAT],
    })
    const a = attribute([r], new Map([[doc.id, doc]]))
    expect(a).toMatchObject({
      labels: 3,
      covered: 3,
      patterns: 1,
      model: 1,
      expansion: 1,
      together: 0,
    })
    // The model's own occurrence is not counted as the search's.
    expect(a.detections.expandedAdded).toBe(1)
    expect(addedByExpansion(r)).toBe(1)
  })

  it("counts a value only the passes together cover as that", () => {
    const doc = document("b")
    const r = record(doc, {
      patterns: [{ start: 5, end: 10, category: "person" }],
      model: [{ start: 11, end: 16, category: "person" }],
    })
    const a = attribute([r], new Map([[doc.id, doc]]))
    expect(a.together).toBe(1)
    expect(a.covered).toBe(1)
  })

  it("buckets what expansion adds by how often the cast is mentioned", () => {
    const once = document("c", { entities: [] })
    const twice = document("d")
    expect(repeatRate(once)).toBe(0)
    expect(repeatRate(twice)).toBe(2)
    const buckets = expansionByRepeat(
      [
        record(once, { model: [NAME] }),
        record(twice, { model: [NAME], expanded: [NAME, REPEAT] }),
      ],
      new Map([once, twice].map((d) => [d.id, d]))
    )
    expect(
      buckets.map((b) => [
        b.bucket,
        b.documents,
        b.added,
        b.labelsOnlyByExpansion,
      ])
    ).toEqual([
      ["none", 1, 0, 0],
      ["1–2", 1, 1, 1],
    ])
  })
})

describe("a run's summary", () => {
  const docs = [
    document("e"),
    document("f", { length: "long", docType: "invoice" }),
  ]
  const byId = docs
  const records = [
    record(
      docs[0],
      { patterns: [PHONE], model: [NAME, REPEAT] },
      { input: 2000, output: 200 }
    ),
    record(docs[1], { model: [NAME] }, { input: 4000, output: 400 }),
  ]
  const rates = { inputPerMillion: 1, outputPerMillion: 5 }
  const run = summarise({
    mode: "deterministic-first",
    records,
    failed: [{ id: "g", error: "refused" }],
    documents: byId,
    rates,
    durationMs: 60_000,
    concurrency: 2,
    commit: "abc1234",
  })

  it("prices tokens at the configured rates, and leaves cost empty without them", () => {
    expect(
      costOf({ inputTokens: 1_000_000, outputTokens: 100_000 }, rates)
    ).toBe(1.5)
    expect(costOf({ inputTokens: 5, outputTokens: 5 }, null)).toBeNull()
    expect(run.totals).toMatchObject({
      calls: 4,
      inputTokens: 6000,
      outputTokens: 600,
      costUsd: 0.009,
    })
    expect(run.perDocument.costUsd).toBe(0.0045)
  })

  it("groups by length and type, with a cost per document for each", () => {
    expect(Object.keys(run.byLength)).toEqual(["short", "long"])
    expect(run.byLength.long.costPerDocumentUsd).toBe(0.006)
    expect(run.byDocType.invoice.tokensPerDocument).toBe(4400)
    expect(run.byDocType["email thread"].recall).toBe(1)
  })

  it("keeps the documents the app refused, and the timings of those it did not", () => {
    expect(run.failed).toEqual([{ id: "g", error: "refused" }])
    expect(run.stages.analyze).toMatchObject({ documents: 2, medianMs: 1200 })
    expect(run.stages.extract).toBeNull()
  })

  it("turns a sweep level into documents and calls per minute", () => {
    const point = throughputPoint(4, records, 30_000)
    expect(point).toMatchObject({
      concurrency: 4,
      documents: 2,
      documentsPerMinute: 4,
      callsPerMinute: 8,
    })
  })
})

describe("the results file", () => {
  it("keeps offsets on one line, and stays JSON", () => {
    const value = {
      detections: [
        [5, 16, "person"],
        [20, 28, "phone"],
      ],
      nested: { a: 1 },
    }
    const text = serialise(value)
    expect(text).toContain('[5, 16, "person"]')
    expect(JSON.parse(text)).toEqual(value)
  })
})

// --- the charts ---------------------------------------------------------------

function results(
  label: string,
  model: string,
  when: string,
  options: { cost?: number; f1?: number; hash?: string } = {}
): ModelResults {
  const docs = [document(`${label}-1`)]
  const rec = record(docs[0], {
    patterns: [PHONE],
    model: [NAME],
    expanded: [NAME, REPEAT],
  })
  const rates = {
    inputPerMillion: options.cost ?? 1,
    outputPerMillion: (options.cost ?? 1) * 5,
  }
  const first = summarise({
    mode: "deterministic-first",
    records: [rec],
    failed: [],
    documents: docs,
    rates,
    durationMs: 1000,
    concurrency: 1,
    commit: "abc1234",
  })
  const only = summarise({
    mode: "model-only",
    records: [
      record(docs[0], { model: [NAME, PHONE] }, { input: 1500, output: 150 }),
    ],
    failed: [],
    documents: docs,
    rates,
    durationMs: 1000,
    concurrency: 1,
    commit: "abc1234",
  })
  return {
    schema: BENCH_SCHEMA,
    model,
    provider: "gateway",
    label,
    firstMeasuredAt: when,
    corpus: "synthetic-v1",
    corpusHash: options.hash ?? "sha256:x",
    split: "test",
    format: "text",
    rates,
    commit: "abc1234",
    createdAt: when,
    documents: 1,
    deterministicFirst: true,
    totals: first.totals,
    perDocument: first.perDocument,
    quality: first.quality,
    runs: { "deterministic-first": first, "model-only": only },
    throughput: {
      documents: [],
      points: [
        throughputPoint(1, [rec], 6000),
        throughputPoint(2, [rec], 4000),
      ],
    },
    settings: { aiRequestsPerMinute: null, aiMaxAttempts: null },
    notMeasured: ["Faces."],
  }
}

describe("the charts", () => {
  it("draws nothing without results, and says what each chart needs", () => {
    const report = buildReport({
      results: [],
      baseline: null,
      corpusHash: "sha256:x",
      context: "c",
    })
    expect(report.charts).toEqual([])
    expect(report.missing.map((m) => m.title)).toContain("Cost against quality")
    expect(benchmarksMarkdown(report, "c", "files")).toContain(
      "No model has been benchmarked"
    )
    expect(rootMarkdown(report)).toContain("No model has been benchmarked yet")
  })

  it("draws every chart in both themes from two models", () => {
    const report = buildReport({
      results: [
        results("B", "b/model", "2026-09-02"),
        results("A", "a/model", "2026-09-01", { cost: 3 }),
      ],
      baseline: null,
      corpusHash: "sha256:x",
      context: "c",
    })
    expect(report.charts.map((c) => c.name)).toEqual([
      "cost-per-document",
      "cost-quality-frontier",
      "token-savings",
      "throughput",
      "recall-heatmap",
      "sources",
      "expansion",
    ])
    for (const chart of report.charts) {
      for (const svg of Object.values(chart.svg)) {
        expect(svg.startsWith("<svg")).toBe(true)
        expect(svg).not.toMatch(/NaN|undefined|Infinity/)
      }
      expect(chart.table.split("\n").length).toBeGreaterThan(2)
    }
    // Ordered by when each was first measured, not by file name.
    expect(report.models.map((m) => m.label)).toEqual(["A", "B"])
  })

  it("keeps a model's colour when another model is added", () => {
    const a = results("A", "a/model", "2026-09-01")
    const b = results("B", "b/model", "2026-09-02")
    const colourOf = (svg: string, label: string) =>
      svg.match(
        new RegExp(
          `stroke="(#[0-9a-f]{6})"[^>]*/><circle[^>]*/><text[^>]*>${label}<`
        )
      )?.[1]
    const alone = buildReport({
      results: [a],
      baseline: null,
      corpusHash: null,
      context: "c",
    })
    const joined = buildReport({
      results: [b, a],
      baseline: null,
      corpusHash: null,
      context: "c",
    })
    const svgOf = (r: typeof alone) =>
      r.charts.find((c) => c.name === "throughput")!.svg.light
    expect(colourOf(svgOf(alone), "A")).toBe(LIGHT.series[0])
    expect(colourOf(svgOf(joined), "A")).toBe(LIGHT.series[0])
    expect(colourOf(svgOf(joined), "B")).toBe(LIGHT.series[1])
    expect(DARK.series).toHaveLength(LIGHT.series.length)
  })

  it("leaves out, and names, a model measured on another version of the corpus", () => {
    const report = buildReport({
      results: [
        results("Old", "o/model", "2026-01-01", { hash: "sha256:old" }),
      ],
      baseline: null,
      corpusHash: "sha256:x",
      context: "c",
    })
    expect(report.models).toEqual([])
    expect(report.excluded).toEqual([
      { model: "Old", reason: expect.stringContaining("another version") },
    ])
  })

  it("finds the frontier: models nothing cheaper beats", () => {
    const points = [
      { label: "cheap", x: 0.001, y: 0.8 },
      { label: "worse and dearer", x: 0.01, y: 0.7 },
      { label: "best", x: 0.02, y: 0.9 },
    ]
    expect(paretoFrontier(points).map((p) => p.label)).toEqual([
      "cheap",
      "best",
    ])
  })

  it("prints dollars to two significant figures", () => {
    expect(money(0.001)).toBe("$0.001")
    expect(money(0.00362)).toBe("$0.0036")
    expect(money(0.1)).toBe("$0.10")
    expect(money(2.4)).toBe("$2.40")
    expect(money(0)).toBe("$0")
  })

  it("wraps a note rather than letting it run off the chart", () => {
    const lines = wrap("word ".repeat(80), 400, 11)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(" ")).toBe("word ".repeat(80).trim())
  })
})

describe("the README sections", () => {
  it("replaces only what lies between the markers", () => {
    const doc = `before\n${MARKERS.start}\nold\n${MARKERS.end}\nafter\n`
    expect(replaceSection(doc, `${MARKERS.start}\nnew\n${MARKERS.end}`)).toBe(
      `before\n${MARKERS.start}\nnew\n${MARKERS.end}\nafter\n`
    )
    expect(() => replaceSection("no markers", "x")).toThrow(
      /no <!-- bench:results:start -->/
    )
  })

  it("shows each chart for both themes, with its numbers", () => {
    const report = buildReport({
      results: [results("A", "a/model", "2026-09-01")],
      baseline: null,
      corpusHash: null,
      context: "c",
    })
    const markdown = benchmarksMarkdown(report, "c", "files")
    expect(markdown).toContain('srcset="charts/recall-heatmap-dark.svg"')
    expect(markdown).toContain('src="charts/recall-heatmap-light.svg"')
    expect(markdown).toContain("<summary>The numbers</summary>")
    expect(markdown).toContain("What these numbers do not measure")
    expect(rootMarkdown(report)).toContain(
      "benchmarks/charts/cost-quality-frontier-light.svg"
    )
  })
})
