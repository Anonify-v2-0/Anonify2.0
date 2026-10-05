/**
 * Scores Anonify's detection against the labelled corpus (issues #57, #59).
 *
 *   pnpm corpus:score                         # deterministic detectors only; no key, no cost
 *   pnpm corpus:score --detector pipeline     # the full pipeline, with the benchmark's model
 *   pnpm corpus:score --detector pipeline --model openai:gpt-5-mini
 *   pnpm corpus:score --split dev --limit 20  # a quick look while iterating
 *   pnpm corpus:score --format pdf            # through PDF rendering and extraction
 *   pnpm corpus:score --compare a.json b.json # agreement between two runs
 *
 * Each run writes benchmarks/results/<corpus>-<split>-<detector>.json: the
 * CONTRIBUTING §4 shape (model, corpus, commit, tokens, time), quality per
 * category with covered, any-overlap and category-strict recall, the weighted
 * cost, and every detection by offset, so a later change to the scoring can be
 * applied without running a model again (--rescore) and two runs can be
 * compared. Detections are stored as offsets and a category, never as text.
 *
 * Like bench:models, it reads the benchmark's own environment,
 * benchmarks/.bench/.env, and never .env: the pipeline runs the model saved
 * there (or --model), with the key saved there, and is verified for the run
 * first. With nothing saved, a terminal run asks for a provider and model the
 * way bench:models does, and saves them (see lib/environment.ts).
 *
 * The documents go through `analyzeDocument`, the function an upload goes
 * through. "patterns" runs it with the model switched off, which is exactly
 * what an install without a key does. By default each document is one
 * plain-text page. With --format, it is rendered to that format
 * (corpus/lib/render.ts), read back by the extractor an upload of it goes
 * through, and the detections are carried back to the labels by aligning the
 * extracted text with the original (lib/extraction.ts).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { int } from "./corpus/lib/args"
import { isRenderFormat, RENDER_FORMATS } from "./corpus/lib/render"
import { palette, progressBar, type Palette } from "./corpus/lib/tui"
import type { LabelledDocument } from "./corpus/lib/types"
import {
  parseModels,
  rescoreResults,
  serialise,
  type ModelEntry,
  type ModelResults,
} from "./lib/bench"
import { corpusHash, gitCommit, loadCorpus, percentile } from "./lib/corpus"
import {
  benchEnvName,
  fileSettingStore,
  loadBenchEnv,
  saveBenchEnv,
} from "./lib/environment"
import {
  analyse,
  captureUsage,
  liftSpendCap,
  selectModel,
  withoutModel,
  type Usage,
} from "./lib/pipeline"
import {
  agreement,
  aggregate,
  round,
  scoreDocument,
  type Detected,
  type DocumentScore,
  type Quality,
} from "./lib/scoring"
import { ensureVerified } from "./lib/verify"

const HERE = import.meta.dirname
const RESULTS = path.join(HERE, "results")

const USAGE = `Usage: pnpm corpus:score [options]

  --detector <name>     patterns (default): the deterministic detectors, as an
                        install with no AI key runs them; pipeline: the full
                        analysis, with a model from ${benchEnvName()}
                        (asked for in a terminal when there is none)
  --model <provider:model>  the pipeline's model, instead of the saved one;
                        its key comes from ${benchEnvName()} or the shell
  --corpus <dir>        corpus directory (default benchmarks/corpus/synthetic-v1)
  --split <name>        test (default), dev or all
  --format <name>       text (default): each document as one plain-text page;
                        or ${RENDER_FORMATS.join(", ")}: rendered to that format and
                        read back by its extractor, for the documents that list it
  --ids <a,b,...>       only these documents
  --limit <n>           only the first n documents
  --concurrency <n>     documents analysed at once (default 2)
  --out <file>          results file (default benchmarks/results/<corpus>-<split>-<detector>.json)
  --rescore <file>      score a results file's stored detections again; no detection runs.
                        Takes a bench:models file as well, and scores every run in it
  --compare <a> <b>     agreement between two results files
`

const NOT_MEASURED = [
  "Faces, handwriting, scanned noise and non-Latin scripts, which the corpus does not contain.",
  "Real-world prevalence: categories are over-represented on purpose, so precision here is not precision on real documents.",
  "Token savings from the deterministic pass: every run is deterministic-first; there is no model-only mode to compare against.",
  "Anything a person accepts or rejects in review: every proposal counts as a redaction.",
]

function notMeasured(format: string): string[] {
  return [
    format === "text"
      ? "Extraction: each document is analysed as one plain-text page, so no file format's extraction is exercised; see --format."
      : `Other formats: this run renders to ${format} only, cleanly and without OCR; scanned pages have their own fixtures.`,
    ...NOT_MEASURED,
  ]
}

type Stored = Array<[number, number, string]>

type Results = {
  model: string
  detector: string
  corpus: string
  corpusHash: string | null
  split: string
  /** "text", or the format the documents were rendered to and read back from. */
  format: string
  /** For a rendered run, what extraction did to the documents. */
  rendering: {
    /** Documents the app could not extract, left out of every number. */
    failed: Array<{ id: string; error: string }>
    /** Share of labelled characters extraction gave back. */
    labelRecovery: number | null
    /** Detections over text the original does not have, such as an email header. */
    outsideDocument: number
    /** Characters the format could not carry, rendered as "?". */
    substituted: number
  } | null
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

// --- running the detectors --------------------------------------------------

type Detection = {
  detections: Detected[]
  degraded: string | null
  /** For a rendered run: detections that map to no text of the original. */
  outside?: number
  /** For a rendered run: labelled characters recovered, and out of how many. */
  recovered?: [number, number]
  substituted?: number
}

type Detector = {
  name: string
  model: string
  detect(document: LabelledDocument, format: string): Promise<Detection>
}

/**
 * The one model the pipeline runs: --model, or the model saved for the
 * benchmarks. Several saved means a question in a terminal and --model
 * without one; none saved means setting one up, as bench:models does.
 */
async function pipelineModel(
  given: string | undefined,
  c: Palette
): Promise<ModelEntry> {
  if (given !== undefined) {
    const entries = parseModels(given)
    if (entries.length !== 1)
      throw new Error("--model takes one provider:model")
    return entries[0]
  }
  let saved = parseModels(process.env.BENCH_MODELS ?? "")
  if (saved.length === 1) return saved[0]
  const env = benchEnvName()
  if (!process.stdin.isTTY || process.env.CI)
    throw new Error(
      saved.length > 1
        ? `${saved.length} models are saved in ${env}; name one with --model (${saved.map((e) => `${e.provider}:${e.model}`).join(", ")})`
        : `--detector pipeline needs a model: run it in a terminal to set one up, or pass --model provider:model with its key in ${env}`
    )

  const { note, ok, Prompter } = await import("@/scripts/tty")
  const { askModels } = await import("./lib/setup")
  const prompt = new Prompter(true)
  const onInterrupt = () => {
    prompt.close()
    console.log(c.yellow("\nStopped before anything was scored."))
    process.exit(130)
  }
  process.on("SIGINT", onInterrupt)
  try {
    if (saved.length === 0) {
      note(
        `No model is saved for the benchmarks yet. Choose one; it is saved to ${env}, apart from .env.`
      )
      const chosen = await askModels(prompt, process.env)
      await saveBenchEnv(chosen.updates)
      ok(`Saved to ${env}, for the benchmarks only.`)
      saved = chosen.entries
      if (saved.length === 1) return saved[0]
    }
    return await prompt.choose(
      "Which model should the pipeline run?",
      saved.map((entry) => ({
        value: entry,
        label: `${entry.provider}:${entry.model}`,
      }))
    )
  } finally {
    process.off("SIGINT", onInterrupt)
    prompt.close()
  }
}

async function createDetector(
  name: string,
  model: string | undefined,
  c: Palette
): Promise<Detector> {
  if (name !== "patterns" && name !== "pipeline") {
    throw new Error(
      `--detector must be patterns or pipeline, not ${JSON.stringify(name)}`
    )
  }
  if (name === "patterns" && model !== undefined)
    throw new Error("--model is for --detector pipeline")
  liftSpendCap()
  if (name === "patterns") withoutModel()

  const { aiConfigured, resolveModel } = await import("@/lib/ai/gateway")
  if (name === "pipeline") {
    const entry = await pipelineModel(model, c)
    selectModel(entry.provider, entry.model)
    if (!aiConfigured())
      throw new Error(
        `${entry.provider} is not configured: set its key in ${benchEnvName()}, or run pnpm bench:models in a terminal to set it up`
      )
    console.log(c.dim(`${entry.provider}:${entry.model}`))
    if (!(await ensureVerified(entry, c, false)))
      throw new Error(
        "The model failed verification, so the pipeline would run on the patterns alone; nothing was scored."
      )
  }

  return {
    name,
    model: name === "patterns" ? "none" : resolveModel(),
    async detect(document, format) {
      const result = await analyse(document, format)
      return {
        detections: result.detections,
        degraded: result.degraded,
        outside: result.outside,
        recovered: result.recovered,
        substituted: result.substituted,
      }
    },
  }
}

// --- reporting --------------------------------------------------------------

function percent(value: number | null): string {
  return value === null ? "  —  " : `${(value * 100).toFixed(1)}%`.padStart(6)
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
  model?: string
  corpus: string
  split: string
  ids?: string
  limit?: string
  concurrency: string
  out?: string
  format: string
}) {
  const c = palette()
  if (!["test", "dev", "all"].includes(values.split))
    throw new Error(
      `--split must be test, dev or all, not ${JSON.stringify(values.split)}`
    )
  const format = values.format
  if (format !== "text" && !isRenderFormat(format))
    throw new Error(
      `--format must be text or one of ${RENDER_FORMATS.join(", ")}, not ${JSON.stringify(format)}`
    )
  const root = path.resolve(values.corpus)
  let documents = await loadCorpus(root, values.split)
  // A document is rendered only to the formats its type is written for: an
  // invoice as a PDF, a tabular export as CSV, not the other way round.
  if (format !== "text")
    documents = documents.filter((document) => document.render.includes(format))
  if (values.ids) {
    const wanted = new Set(values.ids.split(",").map((id) => id.trim()))
    documents = documents.filter((document) => wanted.has(document.id))
  }
  if (values.limit !== undefined)
    documents = documents.slice(0, int("limit", values.limit, 1))
  const concurrency = int("concurrency", values.concurrency, 1)

  // A ChatGPT sign-in is the benchmark's own, never the instance's.
  const usage = await captureUsage(undefined, { setting: fileSettingStore() })
  const detector = await createDetector(values.detector, values.model, c)
  console.log(
    `${c.bold("Scoring")} ${detector.name} ${c.dim(detector.model === "none" ? "(no model)" : `(${detector.model})`)} on ${documents.length} ${values.split} documents of ${path.basename(root)}${format === "text" ? "" : `, as ${format}`}`
  )

  const detections: Record<string, Detected[]> = {}
  const durations: number[] = []
  const degraded: Record<string, number> = {}
  const failed: Array<{ id: string; error: string }> = []
  const recovered = [0, 0]
  let outside = 0
  let substituted = 0
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
      let result: Detection
      try {
        result = await detector.detect(document, format)
      } catch (error) {
        // The app refused the file: that is a finding, not a crash.
        failed.push({
          id: document.id,
          error: (error as Error).message.split("\n")[0].slice(0, 200),
        })
        done++
        progress()
        continue
      }
      durations.push(Date.now() - began)
      detections[document.id] = result.detections
      outside += result.outside ?? 0
      substituted += result.substituted ?? 0
      if (result.recovered) {
        recovered[0] += result.recovered[0]
        recovered[1] += result.recovered[1]
      }
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

  const scored = documents.filter((document) => detections[document.id])
  const scores = scored.map((document) =>
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
    format,
    rendering:
      format === "text"
        ? null
        : {
            failed,
            labelRecovery: recovered[1]
              ? round(recovered[0] / recovered[1])
              : null,
            outsideDocument: outside,
            substituted,
          },
    commit: gitCommit(),
    createdAt: new Date().toISOString(),
    documents: scored.length,
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
        costUsd === null || scored.length === 0
          ? null
          : round(costUsd / scored.length, 6),
    },
    degraded: {
      documents: Object.values(degraded).reduce((a, b) => a + b, 0),
      reasons: degraded,
    },
    quality,
    byDocType: byDocType(scores, usage),
    notMeasured: notMeasured(format),
    detections: Object.fromEntries(
      scored.map((document) => [document.id, toStored(detections[document.id])])
    ),
  }

  printQuality(quality, c)
  console.log(
    `  ${c.bold("time")} ${(durationMs / 1000).toFixed(1)}s ${c.dim(`(median ${results.perDocument.medianMs} ms, p95 ${results.perDocument.p95Ms} ms a document)`)}${totals.calls ? `  ${c.bold("tokens")} ${totals.inputTokens} in, ${totals.outputTokens} out over ${totals.calls} calls${costUsd === null ? c.dim(" (no rates configured for a cost)") : `, $${costUsd.toFixed(4)}`}` : ""}`
  )
  if (results.rendering) {
    const r = results.rendering
    console.log(
      `  ${c.bold(format)} ${c.dim(`labelled text recovered by extraction ${percent(r.labelRecovery).trim()}; ${r.outsideDocument} detection(s) outside the document; ${r.substituted} character(s) not renderable`)}`
    )
    if (r.failed.length > 0) {
      console.log(
        c.yellow(
          `  The app could not extract ${r.failed.length} of ${documents.length} ${format} file(s), left out of every number above: ${r.failed[0].error}${r.failed.length > 1 ? ` (${r.failed[0].id} and ${r.failed.length - 1} more; see rendering.failed)` : ` (${r.failed[0].id})`}`
        )
      )
    }
  }
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
      : path.join(
          RESULTS,
          `${results.corpus}-${values.split}-${slug}${format === "text" ? "" : `-${format}`}.json`
        ),
    results
  )
}

async function readResults(file: string): Promise<Results> {
  return JSON.parse(await readFile(path.resolve(file), "utf8")) as Results
}

/** Scores the detections a results file already holds, under today's rules. */
async function rescore(file: string, corpus: string) {
  const c = palette()
  const raw = JSON.parse(await readFile(path.resolve(file), "utf8"))
  const hash = await corpusHash(path.resolve(corpus))
  if ("runs" in raw)
    return rescoreModels(file, raw as ModelResults, corpus, hash)
  const results = raw as Results
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
  results.corpusHash = hash
  printQuality(results.quality, c)
  await writeResults(path.resolve(file), results)
}

/** The same for a `pnpm bench:models` file: every run in it, rescored. */
async function rescoreModels(
  file: string,
  results: ModelResults,
  corpus: string,
  hash: string | null
) {
  const c = palette()
  const documents = await loadCorpus(path.resolve(corpus), results.split)
  const rescored = rescoreResults(results, documents, hash)
  await writeFile(path.resolve(file), serialise(rescored))
  console.log(
    `${c.bold("Rescored")} ${rescored.label} ${c.dim(`(${rescored.model})`)}, ${Object.keys(rescored.runs).join(" and ")}`
  )
  for (const [mode, run] of Object.entries(rescored.runs)) {
    const before = results.runs[mode as keyof typeof results.runs]!.quality
    console.log(
      `  ${mode.padEnd(20)} precision ${percent(before.precision).trim()} → ${percent(run.quality.precision).trim()}  recall ${percent(before.recall).trim()} → ${percent(run.quality.recall).trim()}  F1 ${percent(before.f1).trim()} → ${percent(run.quality.f1).trim()}`
    )
  }
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
      model: { type: "string" },
      corpus: {
        type: "string",
        default: path.join(HERE, "corpus", "synthetic-v1"),
      },
      split: { type: "string", default: "test" },
      format: { type: "string", default: "text" },
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
  // The benchmark's own environment, never .env; the shell still wins.
  await loadBenchEnv()
  await run(values)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
