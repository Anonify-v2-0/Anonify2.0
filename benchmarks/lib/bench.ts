import type { LabelledDocument } from "../corpus/lib/types"
import { percentile } from "./corpus"
import type { Passes, TaskUsage, Usage } from "./pipeline"
import {
  aggregate,
  covers,
  round,
  scoreDocument,
  type Detected,
  type Quality,
} from "./scoring"
import type { ModelRates } from "@/lib/ai/usage-types"

/**
 * The results of `pnpm bench:models`, and every number derived from them.
 *
 * One file per model, under benchmarks/results/models/<corpus>-<split>-<format>/.
 * A new model is a new file, so benchmarking one never touches another's
 * numbers; a rerun of the same model replaces only the sections it ran.
 * Each file keeps every document's detections by offset, and what each pass
 * of the analysis contributed, so the scoring can change later without
 * calling a model again and the charts are always drawn from what is here.
 *
 * Nothing in this file calls a model or touches the app: it is arithmetic
 * over records, which is what the tests hold it to.
 */

export const BENCH_SCHEMA = 1

export const MODES = ["deterministic-first", "model-only"] as const
export type Mode = (typeof MODES)[number]

/** `[start, end, category]`: detections are stored as offsets, never as text. */
export type Stored = Array<[number, number, string]>

export function toStored(detections: Detected[]): Stored {
  return detections.map((d) => [d.start, d.end, d.category])
}

export function fromStored(stored: Stored): Detected[] {
  return stored.map(([start, end, category]) => ({ start, end, category }))
}

// --- per document -----------------------------------------------------------

export type DocumentRecord = {
  id: string
  docType: string
  length: string
  density: string
  words: number
  /** Mean mentions per cast member: how often this document's values repeat. */
  repeat: number
  detections: Stored
  passes: {
    patterns: Stored
    rejected: number
    model: Stored
    expanded: Stored
  }
  usage: Usage
  timings: {
    extractMs: number | null
    analyzeMs: number
    exportMs: number | null
  }
  degraded: string | null
  /**
   * The language the analysis read it in, or "undetected". Absent from runs
   * measured before languages were told apart (#43).
   */
  language?: string
  exportError?: string
  outside?: number
  recovered?: [number, number]
  substituted?: number
}

/** A document the app could not take at all (a rendered file it refused). */
export type FailedDocument = { id: string; error: string }

export function repeatRate(document: LabelledDocument): number {
  const cast = document.entities.filter((entity) => entity.mentions > 0)
  if (cast.length === 0) return 0
  return round(
    cast.reduce((sum, entity) => sum + entity.mentions, 0) / cast.length,
    2
  )
}

export function toRecord(
  document: LabelledDocument,
  analysed: {
    detections: Detected[]
    passes: Passes
    degraded: string | null
    language?: string
    timings: DocumentRecord["timings"]
    exportError?: string
    outside?: number
    recovered?: [number, number]
    substituted?: number
  },
  usage: Usage | undefined
): DocumentRecord {
  const ms = (value: number | null) =>
    value === null ? null : Math.round(value)
  return {
    id: document.id,
    docType: document.docType,
    length: document.length,
    density: document.density,
    words: document.words,
    repeat: repeatRate(document),
    detections: toStored(analysed.detections),
    passes: {
      patterns: toStored(analysed.passes.patterns),
      rejected: analysed.passes.rejected,
      model: toStored(analysed.passes.model),
      expanded: toStored(analysed.passes.expanded),
    },
    usage: usage ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      byTask: {},
    },
    timings: {
      extractMs: ms(analysed.timings.extractMs),
      analyzeMs: Math.round(analysed.timings.analyzeMs),
      exportMs: ms(analysed.timings.exportMs),
    },
    degraded: analysed.degraded,
    ...(analysed.language ? { language: analysed.language } : {}),
    ...(analysed.exportError ? { exportError: analysed.exportError } : {}),
    ...(analysed.outside !== undefined ? { outside: analysed.outside } : {}),
    ...(analysed.recovered ? { recovered: analysed.recovered } : {}),
    ...(analysed.substituted !== undefined
      ? { substituted: analysed.substituted }
      : {}),
  }
}

// --- one run ----------------------------------------------------------------

export type Timing = {
  documents: number
  medianMs: number
  p95Ms: number
  totalMs: number
}

export type Group = {
  documents: number
  words: number
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  /** Per document, for comparing groups of different sizes. */
  costPerDocumentUsd: number | null
  tokensPerDocument: number
  medianMs: number
  precision: number | null
  recall: number | null
  f1: number | null
}

/**
 * Where the covered labels came from. Each is credited to the first pass
 * that covers it alone, in the order the analysis runs them: the patterns,
 * then the model, then the local search. A label that only the passes
 * together cover (a name the model found half of) is `together`.
 */
export type Attribution = {
  labels: number
  covered: number
  patterns: number
  model: number
  expansion: number
  together: number
  detections: {
    patterns: number
    /** Deterministic hits the verification call removed. */
    rejected: number
    model: number
    expanded: number
    /** Expanded occurrences at a position no other pass had found. */
    expandedAdded: number
  }
}

/**
 * The local search against how often a document's values repeat. The
 * alternative it replaces is a model that finds every occurrence itself, so
 * each occurrence the search added is, at most, work the model was spared.
 */
export type ExpansionBucket = {
  bucket: string
  documents: number
  /** Occurrences the local search added that no other pass found. */
  added: number
  addedPerDocument: number
  /** Labels only the local search covered. */
  labelsOnlyByExpansion: number
  modelCalls: number
}

export const REPEAT_BUCKETS: Array<[string, number, number]> = [
  ["none", 0, 1],
  ["1–2", 1, 2.5],
  ["2.5–5", 2.5, 5],
  ["5–10", 5, 10],
  ["10+", 10, Infinity],
]

export type RunSummary = {
  mode: Mode
  commit: string | null
  createdAt: string
  documents: number
  failed: FailedDocument[]
  totals: {
    calls: number
    inputTokens: number
    outputTokens: number
    /** Wall-clock of the whole run, at `concurrency` documents at once. */
    durationMs: number
    costUsd: number | null
  }
  perDocument: {
    medianMs: number
    p95Ms: number
    costUsd: number | null
    inputTokens: number
    outputTokens: number
  }
  concurrency: number
  byTask: Record<string, TaskUsage>
  stages: {
    extract: Timing | null
    analyze: Timing
    export: Timing | null
    exportFailures: FailedDocument[]
  }
  degraded: { documents: number; reasons: Record<string, number> }
  quality: Quality
  byDocType: Record<string, Group>
  byLength: Record<string, Group>
  byDensity: Record<string, Group>
  /**
   * By the corpus document's locale. Absent from results measured before it
   * existed.
   */
  byLocale?: Record<string, Group>
  attribution: Attribution
  expansion: ExpansionBucket[]
  records: DocumentRecord[]
}

export function costOf(
  tokens: { inputTokens: number; outputTokens: number },
  rates: ModelRates | null
): number | null {
  if (!rates) return null
  return round(
    (tokens.inputTokens / 1_000_000) * rates.inputPerMillion +
      (tokens.outputTokens / 1_000_000) * rates.outputPerMillion,
    6
  )
}

function timing(values: Array<number | null>): Timing | null {
  const present = values.filter((v): v is number => v !== null)
  if (present.length === 0) return null
  return {
    documents: present.length,
    medianMs: percentile(present, 0.5),
    p95Ms: percentile(present, 0.95),
    totalMs: present.reduce((a, b) => a + b, 0),
  }
}

function sumUsage(records: DocumentRecord[]) {
  return records.reduce(
    (sum, r) => ({
      calls: sum.calls + r.usage.calls,
      inputTokens: sum.inputTokens + r.usage.inputTokens,
      outputTokens: sum.outputTokens + r.usage.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 }
  )
}

function group(
  records: DocumentRecord[],
  byId: Map<string, LabelledDocument>,
  rates: ModelRates | null
): Group {
  const usage = sumUsage(records)
  const cost = costOf(usage, rates)
  const quality = aggregate(
    records.map((r) => scoreDocument(byId.get(r.id)!, fromStored(r.detections)))
  )
  return {
    documents: records.length,
    words: records.reduce((n, r) => n + r.words, 0),
    ...usage,
    costUsd: cost,
    costPerDocumentUsd:
      cost === null || records.length === 0
        ? null
        : round(cost / records.length, 6),
    tokensPerDocument: records.length
      ? Math.round((usage.inputTokens + usage.outputTokens) / records.length)
      : 0,
    medianMs: percentile(
      records.map((r) => r.timings.analyzeMs),
      0.5
    ),
    precision: quality.precision,
    recall: quality.recall,
    f1: quality.f1,
  }
}

function groupBy(
  records: DocumentRecord[],
  key: (record: DocumentRecord) => string,
  byId: Map<string, LabelledDocument>,
  rates: ModelRates | null,
  order?: readonly string[]
): Record<string, Group> {
  const groups = new Map<string, DocumentRecord[]>()
  for (const record of records)
    groups.set(key(record), [...(groups.get(key(record)) ?? []), record])
  const keys = [...groups.keys()].sort((a, b) =>
    order ? order.indexOf(a) - order.indexOf(b) : a.localeCompare(b)
  )
  return Object.fromEntries(
    keys.map((k) => [k, group(groups.get(k)!, byId, rates)])
  )
}

function positionKey(d: Detected): string {
  return `${d.start}:${d.end}`
}

export function attribute(
  records: DocumentRecord[],
  byId: Map<string, LabelledDocument>
): Attribution {
  const out: Attribution = {
    labels: 0,
    covered: 0,
    patterns: 0,
    model: 0,
    expansion: 0,
    together: 0,
    detections: {
      patterns: 0,
      rejected: 0,
      model: 0,
      expanded: 0,
      expandedAdded: 0,
    },
  }
  for (const record of records) {
    const document = byId.get(record.id)!
    const final = fromStored(record.detections)
    const patterns = fromStored(record.passes.patterns)
    const model = fromStored(record.passes.model)
    const expanded = fromStored(record.passes.expanded)
    out.detections.patterns += patterns.length
    out.detections.rejected += record.passes.rejected
    out.detections.model += model.length
    out.detections.expanded += expanded.length
    out.detections.expandedAdded += addedByExpansion(record)
    for (const span of document.spans) {
      out.labels++
      if (!covers(document.text, span, final)) continue
      out.covered++
      if (covers(document.text, span, patterns)) out.patterns++
      else if (covers(document.text, span, model)) out.model++
      else if (covers(document.text, span, expanded)) out.expansion++
      else out.together++
    }
  }
  return out
}

/** Expanded occurrences at a position neither the patterns nor the model had. */
export function addedByExpansion(record: DocumentRecord): number {
  const found = new Set(
    [
      ...fromStored(record.passes.patterns),
      ...fromStored(record.passes.model),
    ].map(positionKey)
  )
  const added = new Set<string>()
  for (const d of fromStored(record.passes.expanded)) {
    const key = positionKey(d)
    if (!found.has(key)) added.add(key)
  }
  return added.size
}

export function expansionByRepeat(
  records: DocumentRecord[],
  byId: Map<string, LabelledDocument>
): ExpansionBucket[] {
  return REPEAT_BUCKETS.map(([bucket, low, high]) => {
    const inBucket = records.filter((r) => r.repeat >= low && r.repeat < high)
    let added = 0
    let onlyByExpansion = 0
    for (const record of inBucket) {
      added += addedByExpansion(record)
      const document = byId.get(record.id)!
      const others = [
        ...fromStored(record.passes.patterns),
        ...fromStored(record.passes.model),
      ]
      const all = fromStored(record.detections)
      for (const span of document.spans) {
        if (
          covers(document.text, span, all) &&
          !covers(document.text, span, others)
        )
          onlyByExpansion++
      }
    }
    return {
      bucket,
      documents: inBucket.length,
      added,
      addedPerDocument: inBucket.length ? round(added / inBucket.length, 2) : 0,
      labelsOnlyByExpansion: onlyByExpansion,
      modelCalls: inBucket.reduce((n, r) => n + r.usage.calls, 0),
    }
  }).filter((bucket) => bucket.documents > 0)
}

const LENGTHS = ["short", "medium", "long"] as const
const DENSITIES = ["none", "low", "medium", "high"] as const

export function summarise(input: {
  mode: Mode
  records: DocumentRecord[]
  failed: FailedDocument[]
  documents: LabelledDocument[]
  rates: ModelRates | null
  durationMs: number
  concurrency: number
  commit: string | null
}): RunSummary {
  const { records, rates } = input
  const byId = new Map(input.documents.map((d) => [d.id, d]))
  const usage = sumUsage(records)
  const cost = costOf(usage, rates)
  const byTask: Record<string, TaskUsage> = {}
  for (const record of records) {
    for (const [task, u] of Object.entries(record.usage.byTask)) {
      const into = (byTask[task] ??= {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      })
      into.calls += u.calls
      into.inputTokens += u.inputTokens
      into.outputTokens += u.outputTokens
      into.durationMs += u.durationMs
    }
  }
  const degraded: Record<string, number> = {}
  for (const record of records)
    if (record.degraded)
      degraded[record.degraded] = (degraded[record.degraded] ?? 0) + 1
  const n = records.length
  return {
    mode: input.mode,
    commit: input.commit,
    createdAt: new Date().toISOString(),
    documents: n,
    failed: input.failed,
    totals: {
      ...usage,
      durationMs: Math.round(input.durationMs),
      costUsd: cost,
    },
    perDocument: {
      medianMs: percentile(
        records.map((r) => r.timings.analyzeMs),
        0.5
      ),
      p95Ms: percentile(
        records.map((r) => r.timings.analyzeMs),
        0.95
      ),
      costUsd: cost === null || n === 0 ? null : round(cost / n, 6),
      inputTokens: n ? Math.round(usage.inputTokens / n) : 0,
      outputTokens: n ? Math.round(usage.outputTokens / n) : 0,
    },
    concurrency: input.concurrency,
    byTask,
    stages: {
      extract: timing(records.map((r) => r.timings.extractMs)),
      analyze: timing(records.map((r) => r.timings.analyzeMs))!,
      export: timing(records.map((r) => r.timings.exportMs)),
      exportFailures: records
        .filter((r) => r.exportError)
        .map((r) => ({ id: r.id, error: r.exportError! })),
    },
    degraded: {
      documents: Object.values(degraded).reduce((a, b) => a + b, 0),
      reasons: degraded,
    },
    quality: aggregate(
      records.map((r) =>
        scoreDocument(byId.get(r.id)!, fromStored(r.detections))
      )
    ),
    byDocType: groupBy(records, (r) => r.docType, byId, rates),
    byLength: groupBy(records, (r) => r.length, byId, rates, LENGTHS),
    byDensity: groupBy(records, (r) => r.density, byId, rates, DENSITIES),
    byLocale: groupBy(records, (r) => byId.get(r.id)!.locale, byId, rates),
    attribution: attribute(records, byId),
    expansion: expansionByRepeat(records, byId),
    records,
  }
}

// --- throughput -------------------------------------------------------------

export type ThroughputPoint = {
  concurrency: number
  documents: number
  durationMs: number
  documentsPerMinute: number
  callsPerMinute: number
  tokensPerMinute: number
  p95Ms: number
  /** Documents whose model pass was cut short, by reason: where the limit bites. */
  degraded: Record<string, number>
  /**
   * What the level spent. Absent from points measured before it was
   * recorded; the chart of tokens and cost leaves the sweep out for them.
   */
  inputTokens?: number
  outputTokens?: number
  costUsd?: number | null
}

export function throughputPoint(
  concurrency: number,
  records: DocumentRecord[],
  durationMs: number,
  rates: ModelRates | null = null
): ThroughputPoint {
  const usage = sumUsage(records)
  const minutes = Math.max(durationMs, 1) / 60_000
  const degraded: Record<string, number> = {}
  for (const record of records)
    if (record.degraded)
      degraded[record.degraded] = (degraded[record.degraded] ?? 0) + 1
  return {
    concurrency,
    documents: records.length,
    durationMs: Math.round(durationMs),
    documentsPerMinute: round(records.length / minutes, 2),
    callsPerMinute: round(usage.calls / minutes, 1),
    tokensPerMinute: Math.round(
      (usage.inputTokens + usage.outputTokens) / minutes
    ),
    p95Ms: percentile(
      records.map((r) => r.timings.analyzeMs),
      0.95
    ),
    degraded,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: costOf(usage, rates),
  }
}

// --- the file ---------------------------------------------------------------

export type ModelResults = {
  schema: typeof BENCH_SCHEMA
  /** The usage id: `anthropic/claude-haiku-4.5` on the gateway, `provider:model` elsewhere. */
  model: string
  provider: string
  /** A short name for charts; the model id unless BENCH_MODELS gave one. */
  label: string
  /**
   * When this model was first benchmarked here. Charts give models their
   * colours in this order, so adding a model never repaints the others.
   */
  firstMeasuredAt: string
  corpus: string
  /** The version of the corpus the numbers here are scored against. */
  corpusHash: string | null
  /**
   * Set when the stored detections were scored again (`pnpm corpus:score
   * --rescore`): when, and the corpus version the model actually read. The
   * texts are the same; only the labels moved.
   */
  rescored?: { at: string; detectedOn: string | null }
  split: string
  format: string
  /** Prices used for every cost here; null when none were configured. */
  rates: ModelRates | null
  /** The CONTRIBUTING §4 fields, from the deterministic-first run. */
  commit: string | null
  createdAt: string
  documents: number
  deterministicFirst: true
  totals: RunSummary["totals"] | null
  perDocument: RunSummary["perDocument"] | null
  quality: Quality | null
  runs: Partial<Record<Mode, RunSummary>>
  throughput: { documents: string[]; points: ThroughputPoint[] } | null
  settings: {
    aiRequestsPerMinute: string | null
    aiMaxAttempts: string | null
  }
  notMeasured: string[]
}

export const NOT_MEASURED = [
  "Faces, handwriting, scanned noise and non-Latin scripts, which the corpus does not contain.",
  "Real-world prevalence: categories are over-represented on purpose, so precision here is not precision on real documents.",
  "Anything a person accepts or rejects in review: every proposal counts as a redaction, and the export stage exports all of them.",
  "Model calls saved by expansion are not observed directly: the pipeline never asks the model per occurrence, so the saving is counted as the occurrences the local search added that no model call found.",
  "Cost is tokens times the configured price; cached-input discounts, batch pricing and a subscription's flat fee are not modelled.",
  "Throughput depends on the provider, the plan's rate limits and the network at the time of the run; it is one afternoon, not a property of the model.",
]

export function notMeasured(format: string): string[] {
  return [
    format === "text"
      ? "Extraction and export: each document is analysed as one plain-text page, so the extract and export stages are not timed; see --format."
      : `Other formats: this run renders to ${format} only, cleanly and without OCR; scanned pages have their own fixtures.`,
    ...NOT_MEASURED,
  ]
}

/**
 * Scores the detections a results file already holds again, against the
 * corpus as it is now and under today's scoring, without calling a model.
 * Tokens, timings and what each pass found carry over: they are in the
 * records. Only the labels may have changed since the run. A document whose
 * text changed, which a different word count gives away, cannot be rescored,
 * because its detections no longer point at the same characters.
 */
export function rescoreResults(
  results: ModelResults,
  documents: LabelledDocument[],
  corpusHash: string | null
): ModelResults {
  const byId = new Map(documents.map((d) => [d.id, d]))
  const runs: ModelResults["runs"] = {}
  for (const [mode, run] of Object.entries(results.runs) as Array<
    [Mode, RunSummary]
  >) {
    for (const record of run.records) {
      const document = byId.get(record.id)
      if (!document || document.words !== record.words)
        throw new Error(
          `${record.id} is not the document ${results.label}'s ${mode} run read; measure it again with --replace`
        )
    }
    runs[mode] = {
      ...summarise({
        mode,
        records: run.records,
        failed: run.failed,
        documents,
        rates: results.rates,
        durationMs: run.totals.durationMs,
        concurrency: run.concurrency,
        commit: run.commit,
      }),
      createdAt: run.createdAt,
    }
  }
  const moved = results.corpusHash !== corpusHash
  return withHeadline({
    ...results,
    corpusHash,
    ...(moved || results.rescored
      ? {
          rescored: {
            at: new Date().toISOString(),
            detectedOn: results.rescored?.detectedOn ?? results.corpusHash,
          },
        }
      : {}),
    runs,
  })
}

/** Fills the §4 fields from the deterministic-first run, when there is one. */
export function withHeadline(results: ModelResults): ModelResults {
  const run = results.runs["deterministic-first"]
  return {
    ...results,
    commit: run?.commit ?? results.commit,
    documents: run?.documents ?? 0,
    totals: run?.totals ?? null,
    perDocument: run?.perDocument ?? null,
    quality: run?.quality ?? null,
  }
}

/**
 * Pretty JSON, with arrays of plain values kept on one line, so a results
 * file with thousands of `[start, end, category]` detections stays readable
 * in a diff instead of running to five lines a detection.
 */
export function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(
    /\[\s+([^[\]{}]*?)\s+\]/g,
    (_, inner: string) => `[${inner.replace(/\s*\n\s*/g, " ")}]`
  )}\n`
}

/** A file name for a model: stable, and safe on every filesystem. */
export function modelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "")
}

export function resultsDirectory(
  corpus: string,
  split: string,
  format: string
): string {
  return `${corpus}-${split}-${format}`
}

// --- the models to run ------------------------------------------------------

export type ModelEntry = { provider: string; model: string; label: string }

/**
 * `BENCH_MODELS`, or `--models`: entries separated by commas or new lines,
 * each `provider:model`, optionally followed by `=label`.
 *
 *   gateway:anthropic/claude-haiku-4.5, openai:gpt-5-mini=GPT-5 mini
 *
 * The provider is everything before the first colon, so a model id with a
 * colon of its own (`ollama:llama3.1:8b`) survives. An entry with no colon is
 * a model on the gateway.
 */
export function parseModels(raw: string): ModelEntry[] {
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [spec, ...label] = entry.split("=")
      const colon = spec.indexOf(":")
      const provider = colon === -1 ? "gateway" : spec.slice(0, colon).trim()
      const model = (colon === -1 ? spec : spec.slice(colon + 1)).trim()
      if (!provider || !model)
        throw new Error(
          `BENCH_MODELS: ${JSON.stringify(entry)} is not provider:model`
        )
      return { provider, model, label: label.join("=").trim() || model }
    })
}
