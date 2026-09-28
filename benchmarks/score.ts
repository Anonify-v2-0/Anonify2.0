/**
 * Scores Anonify's detection against the labelled corpus (issues #57, #59).
 *
 *   pnpm corpus:score                         # deterministic detectors only; no key, no cost
 *   pnpm corpus:score --detector pipeline     # the full pipeline, with AI_MODEL from .env
 *   pnpm corpus:score --split dev --limit 20  # a quick look while iterating
 *   pnpm corpus:score --compare a.json b.json # agreement between two runs
 *
 * Each run writes benchmarks/results/<corpus>-<split>-<detector>.json: the
 * CONTRIBUTING §4 shape (model, corpus, commit, tokens, time), quality per
 * category with covered, any-overlap and category-strict recall, the weighted
 * cost, and every detection by offset, so a later change to the scoring can be
 * applied without running a model again (--rescore) and two runs can be
 * compared. Detections are stored as offsets and a category, never as text.
 *
 * The documents go through `analyzeDocument`, the function an upload goes
 * through, as one plain-text page each. "patterns" runs it with the model
 * switched off, which is exactly what an install without a key does.
 */

import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { syncBeforeRun } from "./corpus/lib/archive"
import { int } from "./corpus/lib/args"
import { listDocumentFiles } from "./corpus/lib/manifest"
import { palette, progressBar, type Palette } from "./corpus/lib/tui"
import type { LabelledDocument } from "./corpus/lib/types"
import {
  agreement,
  aggregate,
  round,
  scoreDocument,
  type Detected,
  type DocumentScore,
  type Quality,
} from "./lib/scoring"

const HERE = import.meta.dirname
const RESULTS = path.join(HERE, "results")

const USAGE = `Usage: pnpm corpus:score [options]

  --detector <name>     patterns (default): the deterministic detectors, as an
                        install with no AI key runs them; pipeline: the full
                        analysis, with the provider and AI_MODEL in .env
  --corpus <dir>        corpus directory (default benchmarks/corpus/synthetic-v1)
  --split <name>        test (default), dev or all
  --ids <a,b,...>       only these documents
  --limit <n>           only the first n documents
  --concurrency <n>     documents analysed at once (default 2)
  --out <file>          results file (default benchmarks/results/<corpus>-<split>-<detector>.json)
  --rescore <file>      score a results file's stored detections again; no detection runs
  --compare <a> <b>     agreement between two results files
`

const NOT_MEASURED = [
  "Extraction and rendering: each document is analysed as one plain-text page, so PDF, DOCX, EML, spreadsheet and OCR handling are not exercised (render.ts is not built yet).",
  "Faces, handwriting, scanned noise and non-Latin scripts, which the corpus does not contain.",
  "Real-world prevalence: categories are over-represented on purpose, so precision here is not precision on real documents.",
  "Token savings from the deterministic pass: every run is deterministic-first; there is no model-only mode to compare against.",
  "Anything a person accepts or rejects in review: every proposal counts as a redaction.",
]

type Stored = Array<[number, number, string]>

type Results = {
  model: string
  detector: string
  corpus: string
  corpusHash: string | null
  split: string
  commit: string | null
  createdAt: string
  documents: number
  deterministicFirst: true
  totals: {
    calls: number
    inputTokens: number
    outputTokens: number
    durationMs: number
    costUsd: number | null
  }
  perDocument: { medianMs: number; p95Ms: number; costUsd: number | null }
  /** Documents where the model pass was cut short, and why. */
  degraded: { documents: number; reasons: Record<string, number> }
  quality: Quality
  byDocType: Record<
    string,
    {
      documents: number
      precision: number | null
      recall: number | null
      f1: number | null
      inputTokens: number
      outputTokens: number
    }
  >
  notMeasured: string[]
  detections: Record<string, Stored>
}

// --- the corpus -------------------------------------------------------------

async function loadCorpus(
  root: string,
  split: string
): Promise<LabelledDocument[]> {
  await syncBeforeRun(root)
  const files = (await listDocumentFiles(root)).filter(
    (file) => split === "all" || file.startsWith(`${split}/`)
  )
  if (files.length === 0) {
    throw new Error(
      `no ${split === "all" ? "" : `${split} `}documents in ${path.relative(process.cwd(), root)}; is ${path.basename(root)}.tar.gz there?`
    )
  }
  return Promise.all(
    files.map(
      async (file) =>
        JSON.parse(
          await readFile(path.join(root, file), "utf8")
        ) as LabelledDocument
    )
  )
}

async function corpusHash(root: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, "manifest.json"), "utf8")
    )
    return manifest.corpus ?? null
  } catch {
    return null
  }
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim()
  } catch {
    return null
  }
}

// --- running the detectors --------------------------------------------------

type Usage = { calls: number; inputTokens: number; outputTokens: number }

/**
 * Model usage, per document, as the pipeline records it.
 *
 * `runStructured` writes every call to `prisma.aiUsage`. Here that one table
 * is replaced by a tally, so the benchmark's tokens are counted without a
 * database and never land in the instance's own spend history. Anything else
 * a provider asks the database for (a stored subscription login) goes to the
 * real one when DATABASE_URL is set.
 */
async function captureUsage(): Promise<Map<string, Usage>> {
  const usage = new Map<string, Usage>()
  const aiUsage = {
    create: async ({
      data,
    }: {
      data: { documentId: string; inputTokens: number; outputTokens: number }
    }) => {
      const entry = usage.get(data.documentId) ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
      }
      entry.calls++
      entry.inputTokens += data.inputTokens
      entry.outputTokens += data.outputTokens
      usage.set(data.documentId, entry)
      return data
    },
  }
  let real: object | null = null
  if (process.env.DATABASE_URL) {
    const { getPrisma } = await import("@/lib/database/prisma")
    real = getPrisma()
  }
  ;(globalThis as { prisma?: unknown }).prisma = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "aiUsage") return aiUsage
        if (!real) {
          throw new Error(
            `the provider needs the database (prisma.${String(property)}); set DATABASE_URL`
          )
        }
        return Reflect.get(real, property, real)
      },
    }
  )
  return usage
}

type Detector = {
  name: string
  model: string
  detect(document: LabelledDocument): Promise<{
    detections: Detected[]
    degraded: string | null
  }>
}

async function createDetector(name: string): Promise<Detector> {
  if (name !== "patterns" && name !== "pipeline") {
    throw new Error(
      `--detector must be patterns or pipeline, not ${JSON.stringify(name)}`
    )
  }
  // The day's spend cap is the instance's, for its users; a benchmark is
  // measuring, and its calls are not recorded against it (see captureUsage).
  process.env.ANONIFY_AI_DAILY_SPEND_USD = "0"
  if (name === "patterns") {
    process.env.AI_PROVIDER = "gateway"
    delete process.env.AI_GATEWAY_API_KEY
    delete process.env.VERCEL_OIDC_TOKEN
  }

  const { aiConfigured, resolveModel } = await import("@/lib/ai/gateway")
  const { analyzeDocument } = await import("@/lib/ai/analyze")
  if (name === "pipeline" && !aiConfigured()) {
    throw new Error(
      "--detector pipeline needs a configured provider: set AI_PROVIDER, AI_MODEL and its key in .env (pnpm setup writes them)"
    )
  }

  return {
    name,
    model: name === "patterns" ? "none" : resolveModel(),
    async detect(document) {
      const result = await analyzeDocument(document.id, {
        documentId: document.id,
        kind: "txt",
        pages: [
          { number: 1, width: 0, height: 0, text: document.text, spans: [] },
        ],
      })
      return {
        detections: result.detections
          .filter(
            (detection) =>
              detection.start !== undefined && detection.end !== undefined
          )
          .map((detection) => ({
            start: detection.start!,
            end: detection.end!,
            category: detection.category,
          })),
        degraded: result.degraded?.reason ?? null,
      }
    },
  }
}

// --- reporting --------------------------------------------------------------

function percent(value: number | null): string {
  return value === null ? "  —  " : `${(value * 100).toFixed(1)}%`.padStart(6)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

function printQuality(quality: Quality, c: Palette) {
  console.log(
    `\n  ${c.dim("category".padEnd(14))} ${c.dim("labels".padStart(6))}  ${c.dim("recall (covered)".padEnd(33))} ${c.dim("overlap".padStart(7))} ${c.dim("strict".padStart(7))}  ${c.dim("found".padStart(5))} ${c.dim("precision".padStart(9))}`
  )
  for (const [category, q] of Object.entries(quality.byCategory)) {
    if (q.labels === 0 && q.detections === 0) continue
    const recall = q.recall ?? 0
    const color = recall >= 0.9 ? c.green : recall >= 0.5 ? c.yellow : c.red
    console.log(
      `  ${category.padEnd(14)} ${String(q.labels).padStart(6)}  ${progressBar(recall, 24, null, c)} ${color(percent(q.recall))}  ${percent(q.recallOverlap)} ${percent(q.recallStrict)}  ${String(q.detections).padStart(5)}    ${percent(q.precision)}`
    )
  }
  console.log(
    `\n  ${c.bold("overall")}  recall ${c.bold(percent(quality.recall))} ${c.dim(`(overlap ${percent(quality.recallOverlap).trim()}, strict ${percent(quality.recallStrict).trim()})`)}  precision ${c.bold(percent(quality.precision))}  F1 ${c.bold(percent(quality.f1))}`
  )
  const missed = Object.entries(quality.weightedCost.missed)
    .sort((a, b) => b[1] - a[1])
    .map(([category, n]) => `${category} ${n}`)
    .join(", ")
  console.log(
    `  ${c.bold("weighted cost")} ${quality.weightedCost.total} ${c.dim(`(${quality.weightedCost.perDocument} a document; ${quality.falsePositives} false positives, ${quality.negativeHits} of them on hard negatives; missed: ${missed || "nothing"})`)}`
  )
}

async function writeResults(file: string, results: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(results, null, 2)}\n`)
  console.log(`\n  ${path.relative(process.cwd(), file)}`)
}

function toStored(detections: Detected[]): Stored {
  return detections.map((d) => [d.start, d.end, d.category])
}

function fromStored(stored: Stored): Detected[] {
  return stored.map(([start, end, category]) => ({ start, end, category }))
}

function byDocType(
  scores: DocumentScore[],
  usage: Map<string, Usage>
): Results["byDocType"] {
  const groups = new Map<string, DocumentScore[]>()
  for (const score of scores)
    groups.set(score.docType, [...(groups.get(score.docType) ?? []), score])
  return Object.fromEntries(
    [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([docType, group]) => {
        const quality = aggregate(group)
        const tokens = group.map((s) => usage.get(s.id))
        return [
          docType,
          {
            documents: group.length,
            precision: quality.precision,
            recall: quality.recall,
            f1: quality.f1,
            inputTokens: tokens.reduce((n, u) => n + (u?.inputTokens ?? 0), 0),
            outputTokens: tokens.reduce(
              (n, u) => n + (u?.outputTokens ?? 0),
              0
            ),
          },
        ]
      })
  )
}

// --- commands ---------------------------------------------------------------

async function run(values: {
  detector: string
  corpus: string
  split: string
  ids?: string
  limit?: string
  concurrency: string
  out?: string
}) {
  const c = palette()
  if (!["test", "dev", "all"].includes(values.split))
    throw new Error(
      `--split must be test, dev or all, not ${JSON.stringify(values.split)}`
    )
  const root = path.resolve(values.corpus)
  let documents = await loadCorpus(root, values.split)
  if (values.ids) {
    const wanted = new Set(values.ids.split(",").map((id) => id.trim()))
    documents = documents.filter((document) => wanted.has(document.id))
  }
  if (values.limit !== undefined)
    documents = documents.slice(0, int("limit", values.limit, 1))
  const concurrency = int("concurrency", values.concurrency, 1)

  const usage = await captureUsage()
  const detector = await createDetector(values.detector)
  console.log(
    `${c.bold("Scoring")} ${detector.name} ${c.dim(detector.model === "none" ? "(no model)" : `(${detector.model})`)} on ${documents.length} ${values.split} documents of ${path.basename(root)}`
  )

  const detections: Record<string, Detected[]> = {}
  const durations: number[] = []
  const degraded: Record<string, number> = {}
  const startedAt = Date.now()
  const live = process.stdout.isTTY && !process.env.CI
  let next = 0
  let done = 0
  const progress = () => {
    if (!live) return
    const width = Math.min(40, (process.stdout.columns ?? 80) - 30)
    process.stdout.write(
      `\r  ${progressBar(done / documents.length, width, done, c)} ${done}/${documents.length}  ${c.dim(`${Math.round((Date.now() - startedAt) / 1000)}s`)}\x1b[K`
    )
  }
  const worker = async () => {
    while (next < documents.length) {
      const document = documents[next++]
      const began = Date.now()
      const result = await detector.detect(document)
      durations.push(Date.now() - began)
      detections[document.id] = result.detections
      if (result.degraded)
        degraded[result.degraded] = (degraded[result.degraded] ?? 0) + 1
      done++
      progress()
    }
  }
  progress()
  await Promise.all(
    Array.from({ length: Math.min(concurrency, documents.length) }, worker)
  )
  if (live) process.stdout.write("\r\x1b[K")
  const durationMs = Date.now() - startedAt

  const scores = documents.map((document) =>
    scoreDocument(document, detections[document.id])
  )
  const quality = aggregate(scores)
  const totals = [...usage.values()].reduce(
    (sum, u) => ({
      calls: sum.calls + u.calls,
      inputTokens: sum.inputTokens + u.inputTokens,
      outputTokens: sum.outputTokens + u.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 }
  )
  const { configuredRates } = await import("@/lib/ai/rates")
  const { estimateCost } = await import("@/lib/ai/usage-types")
  const costUsd =
    detector.name === "patterns"
      ? 0
      : estimateCost(totals, configuredRates(detector.model))

  const results: Results = {
    model: detector.model,
    detector: detector.name,
    corpus: path.basename(root),
    corpusHash: await corpusHash(root),
    split: values.split,
    commit: gitCommit(),
    createdAt: new Date().toISOString(),
    documents: documents.length,
    deterministicFirst: true,
    totals: {
      ...totals,
      durationMs,
      costUsd: costUsd === null ? null : round(costUsd, 6),
    },
    perDocument: {
      medianMs: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      costUsd:
        costUsd === null || documents.length === 0
          ? null
          : round(costUsd / documents.length, 6),
    },
    degraded: {
      documents: Object.values(degraded).reduce((a, b) => a + b, 0),
      reasons: degraded,
    },
    quality,
    byDocType: byDocType(scores, usage),
    notMeasured: NOT_MEASURED,
    detections: Object.fromEntries(
      documents.map((document) => [
        document.id,
        toStored(detections[document.id]),
      ])
    ),
  }

  printQuality(quality, c)
  console.log(
    `  ${c.bold("time")} ${(durationMs / 1000).toFixed(1)}s ${c.dim(`(median ${results.perDocument.medianMs} ms, p95 ${results.perDocument.p95Ms} ms a document)`)}${totals.calls ? `  ${c.bold("tokens")} ${totals.inputTokens} in, ${totals.outputTokens} out over ${totals.calls} calls${costUsd === null ? c.dim(" (no rates configured for a cost)") : `, $${costUsd.toFixed(4)}`}` : ""}`
  )
  if (results.degraded.documents > 0) {
    console.log(
      c.yellow(
        `  The model pass was cut short on ${results.degraded.documents} document(s) (${Object.entries(
          degraded
        )
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}): these numbers are partly pattern matching alone.`
      )
    )
  }
  const slug =
    detector.name === "patterns"
      ? "patterns"
      : `pipeline-${detector.model.replace(/[^A-Za-z0-9.-]+/g, "_")}`
  await writeResults(
    values.out
      ? path.resolve(values.out)
      : path.join(RESULTS, `${results.corpus}-${values.split}-${slug}.json`),
    results
  )
}

async function readResults(file: string): Promise<Results> {
  return JSON.parse(await readFile(path.resolve(file), "utf8")) as Results
}

/** Scores the detections a results file already holds, under today's rules. */
async function rescore(file: string, corpus: string) {
  const c = palette()
  const results = await readResults(file)
  const documents = await loadCorpus(path.resolve(corpus), results.split)
  const scored = documents.filter((d) => results.detections[d.id])
  const scores = scored.map((document) =>
    scoreDocument(document, fromStored(results.detections[document.id]))
  )
  results.quality = aggregate(scores)
  // Tokens were counted when the detections were made; they carry over.
  const previous = results.byDocType
  results.byDocType = byDocType(scores, new Map())
  for (const [docType, entry] of Object.entries(results.byDocType)) {
    entry.inputTokens = previous[docType]?.inputTokens ?? 0
    entry.outputTokens = previous[docType]?.outputTokens ?? 0
  }
  console.log(
    `${c.bold("Rescored")} ${results.detector} ${c.dim(`(${results.model})`)} on ${scores.length} documents`
  )
  printQuality(results.quality, c)
  await writeResults(path.resolve(file), results)
}

async function compare(first: string, second: string, corpus: string) {
  const c = palette()
  const [a, b] = await Promise.all([readResults(first), readResults(second)])
  if (a.corpusHash !== b.corpusHash)
    console.log(
      c.yellow(
        "  The two runs were made on different versions of the corpus; comparing the documents both scored."
      )
    )
  const documents = await loadCorpus(path.resolve(corpus), "all")
  const result = agreement(
    documents,
    Object.fromEntries(
      Object.entries(a.detections).map(([id, s]) => [id, fromStored(s)])
    ),
    Object.fromEntries(
      Object.entries(b.detections).map(([id, s]) => [id, fromStored(s)])
    )
  )
  console.log(
    `${c.bold("Agreement")} ${a.model} ${c.dim("vs")} ${b.model}, over ${result.labels} labelled values`
  )
  console.log(
    `  both covered ${result.bothCovered}, only the first ${result.onlyFirst}, only the second ${result.onlySecond}, neither ${result.neither}`
  )
  console.log(
    `  agree on ${percent(result.observed).trim()} of labels, Cohen's kappa ${result.kappa ?? "—"}, redacted characters in common (Jaccard) ${percent(result.redactedJaccard).trim()}`
  )
  for (const [category, entry] of Object.entries(result.byCategory)) {
    if (entry.labels === 0) continue
    console.log(
      `  ${category.padEnd(14)} ${String(entry.labels).padStart(5)}  agree ${percent(entry.observed)}  kappa ${entry.kappa ?? "—"}`
    )
  }
  return result
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      detector: { type: "string", default: "patterns" },
      corpus: {
        type: "string",
        default: path.join(HERE, "corpus", "synthetic-v1"),
      },
      split: { type: "string", default: "test" },
      ids: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "2" },
      out: { type: "string" },
      rescore: { type: "string" },
      compare: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return
  }
  if (values.rescore) return rescore(values.rescore, values.corpus)
  if (values.compare) {
    const second = positionals[0]
    if (!second)
      throw new Error(
        "--compare takes two results files: --compare a.json b.json"
      )
    const result = await compare(values.compare, second, values.corpus)
    if (values.out) await writeResults(path.resolve(values.out), result)
    return
  }
  await run(values)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
