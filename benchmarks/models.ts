/**
 * Benchmarks models on the labelled corpus (issues #59 and #55).
 *
 *   pnpm bench:models                          # in a terminal: asks which corpus split and how
 *                                              # much of it, which phases, which providers
 *                                              # (a key or a sign-in) and which models
 *   BENCH_MODELS="gateway:anthropic/claude-haiku-4.5, openai:gpt-5-mini" pnpm bench:models
 *   pnpm bench:models --limit 20 --phases deterministic-first   # a quick look
 *   pnpm bench:models --yes                    # the saved setup, without questions
 *   pnpm bench:models --dry-run                # what would run, and what is already measured
 *   pnpm bench:charts                          # redraw the charts from every results file
 *
 * The benchmark keeps its own environment in benchmarks/.bench/ and never
 * reads .env, so measuring a model changes nothing the instance uses (see
 * lib/environment.ts). Its answers are saved there, and offered again next
 * time. When it finishes, or is stopped, it reports what this run spent:
 * calls, tokens and cost for each model and phase.
 *
 * For each model, up to three phases, each written as soon as it finishes:
 *
 * - deterministic-first: the pipeline as it ships. Quality per category,
 *   tokens and cost per document, wall-clock by stage, and what the patterns,
 *   the model and the local search each contributed.
 * - model-only: the same documents with the deterministic pass switched off,
 *   so the tokens it saves are measured rather than asserted (#55).
 * - throughput: a fixed sample at rising concurrency, to find where the
 *   provider's rate limit starts to bite.
 *
 * Results go to benchmarks/results/models/<corpus>-<split>-<format>/<model>.json,
 * one file per model. Benchmarking a new model adds a file; rerunning one
 * leaves every phase it has already measured alone unless --replace says
 * otherwise. Every finished document is checkpointed, so an interrupted run
 * resumes where it stopped instead of paying for the same calls twice.
 */

import { existsSync } from "node:fs"
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { int } from "./corpus/lib/args"
import { isRenderFormat, RENDER_FORMATS } from "./corpus/lib/render"
import { box, duration, palette, type Palette } from "./corpus/lib/tui"
import type { LabelledDocument } from "./corpus/lib/types"
import {
  BENCH_SCHEMA,
  MODES,
  modelSlug,
  notMeasured,
  parseModels,
  resultsDirectory,
  serialise,
  stratifiedSample,
  summarise,
  throughputPoint,
  toRecord,
  withHeadline,
  type DocumentRecord,
  type FailedDocument,
  type Mode,
  type ModelEntry,
  type ModelResults,
  type RunSummary,
  type Selection,
} from "./lib/bench"
import { corpusHash, gitCommit, loadCorpus, parseSplit } from "./lib/corpus"
import { promptFingerprint } from "./lib/fingerprint"
import { BenchDashboard, compact, pct } from "./lib/dashboard"
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
  MODEL_ONLY,
  selectModel,
  type Usage,
} from "./lib/pipeline"
import { money } from "./lib/report"
import { scoreDocument } from "./lib/scoring"
import { SpendLedger, spendTable, spendTotal } from "./lib/spend"
import { ensureVerified } from "./lib/verify"
import type { ModelRates } from "@/lib/ai/usage-types"

const HERE = import.meta.dirname
const RESULTS = path.join(HERE, "results", "models")
const CHECKPOINTS = path.join(HERE, "results", ".checkpoints")

const PHASES = [...MODES, "throughput"] as const
type Phase = (typeof PHASES)[number]

const ENV_NAME = benchEnvName()

const USAGE = `Usage: pnpm bench:models [options]

In a terminal it asks what to run: which split of the corpus and how many of
its documents, which phases, and which providers and models, with a key or a
ChatGPT sign-in for each provider. A question answered by an option below is
not asked. The answers are saved to ${ENV_NAME} and offered next time.

That file is the benchmark's whole environment; .env is never read. It holds
BENCH_MODELS (entries separated by commas or new lines, each provider:model,
optionally =label), each provider's key and settings as the app names them,
and AI_MODEL_PRICES, keyed by the usage id (the model id on the gateway,
provider:model elsewhere). A variable set in the shell overrides it.

  --models <list>        instead of BENCH_MODELS, and no model questions
  --phases <list>        any of ${PHASES.join(", ")}
                         (default: all three)
  --corpus <dir>         corpus directory (default benchmarks/corpus/synthetic-v1)
  --split <name>         test (default), dev or all
  --format <name>        text (default): each document as one plain-text page;
                         or ${RENDER_FORMATS.join(", ")}: rendered, extracted, analysed and
                         exported, for the documents that list that format
  --ids <a,b,...>        only these documents
  --limit <n>            a sample of n documents, stratified by document type
  --seed <n>             which sample --limit draws (default 1)
  --concurrency <n>      documents analysed at once (default 4)
  --sweep <list>         concurrency levels for the throughput phase (default 1,2,4,8)
  --sweep-documents <n>  documents per level (default 24)
  --replace              measure again a phase this model already has
  --fresh                ignore a checkpoint and start the phase over
  --yes                  ask nothing: the saved models and every default
  --dry-run              show what would run, and stop
`

type Options = {
  split: string
  format: string
  concurrency: number
  sweep: number[]
  sweepDocuments: number
  replace: boolean
  fresh: boolean
}

// --- files ------------------------------------------------------------------

async function readResults(file: string): Promise<ModelResults | null> {
  if (!existsSync(file)) return null
  const results = JSON.parse(await readFile(file, "utf8")) as ModelResults
  if (results.schema !== BENCH_SCHEMA)
    throw new Error(
      `${path.relative(process.cwd(), file)} is schema ${results.schema}, not ${BENCH_SCHEMA}; move it aside or pass --replace`
    )
  return results
}

type Checkpoint = {
  records: DocumentRecord[]
  failed: FailedDocument[]
  previousMs: number
}

async function readCheckpoint(
  file: string,
  header: object
): Promise<Checkpoint> {
  const empty = { records: [], failed: [], previousMs: 0 }
  if (!existsSync(file)) return empty
  const [first, ...rest] = (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
  if (first !== JSON.stringify(header)) return empty
  const checkpoint: Checkpoint = empty
  for (const line of rest) {
    try {
      const entry = JSON.parse(line)
      if (entry.record) checkpoint.records.push(entry.record)
      else if (entry.failed) checkpoint.failed.push(entry.failed)
      else if (typeof entry.sessionMs === "number")
        checkpoint.previousMs += entry.sessionMs
    } catch {
      // A line cut short by a crash: the document is simply analysed again.
    }
  }
  return checkpoint
}

// --- one phase --------------------------------------------------------------

let stopping = false

/**
 * Cut-short reasons that are the account's limits, not the model's work: a
 * provider's rate limit or usage quota, or a key it stopped accepting. A
 * document cut short by one says nothing about the model, so it is not
 * recorded, and the phase stops as ctrl+c stops it, to resume once the limit
 * clears. Writing it would have put a run that was mostly the patterns alone
 * over a measured one: 78 of 100 documents, the first time.
 */
const LIMITS = new Set(["rate-limit", "authorization"])
let limitedBy: string | null = null

async function runPhase(input: {
  mode: Mode
  documents: LabelledDocument[]
  concurrency: number
  format: string
  rates: ModelRates | null
  usage: Map<string, Usage>
  checkpoint: string | null
  header: object
  fresh: boolean
  onCall: { current: BenchDashboard | null }
  title: string
}): Promise<{
  records: DocumentRecord[]
  failed: FailedDocument[]
  durationMs: number
} | null> {
  const resumed =
    input.checkpoint && !input.fresh
      ? await readCheckpoint(input.checkpoint, input.header)
      : { records: [], failed: [], previousMs: 0 }
  const done = new Set([
    ...resumed.records.map((r) => r.id),
    ...resumed.failed.map((f) => f.id),
  ])
  const todo = input.documents.filter((d) => !done.has(d.id))
  if (input.checkpoint) {
    await mkdir(path.dirname(input.checkpoint), { recursive: true })
    if (resumed.records.length === 0 && resumed.failed.length === 0)
      await writeFile(input.checkpoint, `${JSON.stringify(input.header)}\n`)
  }

  const board = new BenchDashboard({
    title: input.title,
    total: todo.length,
    concurrency: Math.min(input.concurrency, Math.max(1, todo.length)),
    rates: input.rates,
  })
  const c = board.c
  if (done.size > 0)
    board.log(
      c.dim(
        `  resuming: ${done.size} of ${input.documents.length} documents already analysed in an earlier session`
      )
    )
  input.onCall.current = board
  board.start()

  const records: DocumentRecord[] = []
  const failed: FailedDocument[] = []
  const began = Date.now()
  let next = 0
  const append = async (line: object) => {
    if (input.checkpoint)
      await appendFile(input.checkpoint, `${JSON.stringify(line)}\n`)
  }

  const worker = async (slot: number) => {
    while (!stopping && next < todo.length) {
      const document = todo[next++]
      board.begin(slot, document.id, `${document.docType} · ${document.length}`)
      try {
        const analysed = await analyse(document, input.format, {
          preset: input.mode === "model-only" ? MODEL_ONLY : null,
          timeExport: input.format !== "text",
          onStage: (stage) => board.stage(slot, stage),
        })
        const usage = input.usage.get(document.id)
        input.usage.delete(document.id)
        if (analysed.degraded && LIMITS.has(analysed.degraded)) {
          limitedBy ??= analysed.degraded
          stopping = true
          board.finish(slot, { failed: true })
          board.log(
            `  ${c.yellow("⚠")} ${c.bold(document.id)}  ${c.yellow(`model pass cut short: ${analysed.degraded}; not recorded, stopping after the documents in flight`)}`
          )
          continue
        }
        const record = toRecord(document, analysed, usage)
        records.push(record)
        await append({ record })
        const score = scoreDocument(document, analysed.detections)
        const covered = score.labels.filter((l) => l.covered).length
        const correct = score.detections.filter((d) => d.correct).length
        board.finish(slot, {
          degraded: Boolean(analysed.degraded),
          labels: score.labels.length,
          covered,
          detections: score.detections.length,
          correct,
        })
        const recall = score.labels.length
          ? covered / score.labels.length
          : null
        const mark = analysed.degraded
          ? c.yellow("⚠")
          : recall === null || recall >= 0.9
            ? c.green("✓")
            : recall >= 0.5
              ? c.yellow("✓")
              : c.red("✓")
        board.log(
          `  ${mark} ${c.bold(document.id)}  ${c.dim(`${document.docType} · ${document.length}`.padEnd(30))} ${c.dim("recall")} ${pct(recall).padStart(6)}  ${c.dim(`${record.usage.calls} calls · ${compact(record.usage.inputTokens + record.usage.outputTokens)} tok · ${(record.timings.analyzeMs / 1000).toFixed(1)}s`)}${analysed.degraded ? c.yellow(`  model pass cut short: ${analysed.degraded}`) : ""}${analysed.exportError ? c.yellow(`  export failed: ${analysed.exportError}`) : ""}`
        )
      } catch (error) {
        input.usage.delete(document.id)
        const entry = {
          id: document.id,
          error: (error as Error).message.split("\n")[0].slice(0, 200),
        }
        failed.push(entry)
        await append({ failed: entry })
        board.finish(slot, { failed: true })
        board.log(
          `  ${c.red("✗")} ${c.bold(document.id)}  ${c.red(entry.error)}`
        )
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(input.concurrency, Math.max(1, todo.length)) },
      (_, slot) => worker(slot)
    )
  )
  board.stop()
  input.onCall.current = null
  const sessionMs = Date.now() - began
  await append({ sessionMs })
  if (stopping) return null
  return {
    records: [...resumed.records, ...records],
    failed: [...resumed.failed, ...failed],
    durationMs: resumed.previousMs + sessionMs,
  }
}

// --- reporting --------------------------------------------------------------

function printRun(run: RunSummary, c: Palette, baseline?: RunSummary) {
  const q = run.quality
  const lines = [
    `${c.dim("documents")} ${run.documents}${run.failed.length ? c.yellow(`  (${run.failed.length} refused, left out)`) : ""}`,
    `${c.dim("recall")} ${c.bold(pct(q.recall))}  ${c.dim("precision")} ${c.bold(pct(q.precision))}  ${c.dim("F1")} ${c.bold(pct(q.f1))}  ${c.dim("weighted cost")} ${q.weightedCost.perDocument ?? "—"} ${c.dim("a document")}`,
    ...(q.interval && run.selection?.how !== "all"
      ? [
          c.dim(
            `95% interval over the ${run.documents} documents: precision ${pct(q.interval.precision?.[0] ?? null)}–${pct(q.interval.precision?.[1] ?? null)}, recall ${pct(q.interval.recall?.[0] ?? null)}–${pct(q.interval.recall?.[1] ?? null)}`
          ),
        ]
      : []),
    ...(q.distinct
      ? [
          `${c.dim("precision per distinct value")} ${pct(q.distinct.precision)}${q.byConfidence ? `  ${c.dim("at confidence")} ${q.byConfidence.map((at) => `≥${at.cutoff} ${pct(at.precision)}/${pct(at.recall)}`).join("  ")} ${c.dim("(precision/recall)")}` : ""}`,
        ]
      : []),
    `${c.dim("tokens")} ${compact(run.totals.inputTokens)} in · ${compact(run.totals.outputTokens)} out  ${c.dim(`(${compact(run.perDocument.inputTokens + run.perDocument.outputTokens)} a document, ${run.totals.calls} calls)`)}`,
    `${c.dim("cost")} ${run.totals.costUsd === null ? c.yellow("no price configured (AI_MODEL_PRICES)") : `$${run.totals.costUsd.toFixed(4)}  ${c.dim(`$${run.perDocument.costUsd?.toFixed(5)} a document`)}`}`,
    `${c.dim("time")} ${duration(run.totals.durationMs)}  ${c.dim(`median ${(run.perDocument.medianMs / 1000).toFixed(1)}s, p95 ${(run.perDocument.p95Ms / 1000).toFixed(1)}s a document, ${run.concurrency} at once`)}`,
  ]
  if (run.mode === "deterministic-first") {
    const a = run.attribution
    const share = (n: number) => pct(a.covered ? n / a.covered : null)
    lines.push(
      `${c.dim("covered by")} patterns ${share(a.patterns)} · model ${share(a.model)} · local search ${share(a.expansion)} · together ${share(a.together)}`
    )
  }
  if (baseline) {
    const withTokens =
      baseline.totals.inputTokens + baseline.totals.outputTokens
    const without = run.totals.inputTokens + run.totals.outputTokens
    if (without > 0)
      lines.push(
        `${c.dim("deterministic-first spends")} ${c.bold(pct(without ? 1 - withTokens / without : null))} ${c.dim("fewer tokens than this, at recall")} ${pct(baseline.quality.recall)} ${c.dim("against")} ${pct(q.recall)}`
      )
  }
  if (run.degraded.documents)
    lines.push(
      (run.degraded.documents === run.documents ? c.red : c.yellow)(
        `model pass cut short on ${run.degraded.documents} of ${run.documents} documents: ${Object.entries(
          run.degraded.reasons
        )
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}`
      ),
      ...(run.degraded.documents === run.documents
        ? [
            c.red(
              "every document: these are the patterns' numbers, not the model's. Check the key, the plan and pnpm ai verify, then --replace."
            ),
          ]
        : [])
    )
  console.log(`\n${box(lines, c, run.mode)}`)
}

async function printTable(directory: string, c: Palette) {
  if (!existsSync(directory)) return
  const files = (await readdir(directory)).filter((f) => f.endsWith(".json"))
  const rows: string[][] = []
  for (const file of files) {
    const r = JSON.parse(
      await readFile(path.join(directory, file), "utf8")
    ) as ModelResults
    const first = r.runs["deterministic-first"]
    const only = r.runs["model-only"]
    const without = only
      ? only.totals.inputTokens + only.totals.outputTokens
      : 0
    const saved =
      first && without > 0
        ? 1 - (first.totals.inputTokens + first.totals.outputTokens) / without
        : null
    rows.push([
      r.label,
      pct(first?.quality.recall ?? null),
      pct(first?.quality.precision ?? null),
      pct(first?.quality.f1 ?? null),
      first?.perDocument.costUsd == null
        ? "—"
        : `$${first.perDocument.costUsd.toFixed(5)}`,
      first
        ? compact(
            first.perDocument.inputTokens + first.perDocument.outputTokens
          )
        : "—",
      pct(saved),
      r.throughput
        ? `${Math.max(...r.throughput.points.map((p) => p.documentsPerMinute)).toFixed(1)}`
        : "—",
    ])
  }
  if (rows.length === 0) return
  const head = [
    "model",
    "recall",
    "precision",
    "F1",
    "$/doc",
    "tok/doc",
    "saved",
    "best docs/min",
  ]
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  )
  const line = (cells: string[]) =>
    cells
      .map((cell, i) =>
        i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])
      )
      .join("  ")
  console.log(
    `\n${box([c.dim(line(head)), ...rows.map(line)], c, `every model on ${path.basename(directory)}`)}`
  )
}

/**
 * What this run spent, model by model and phase by phase. Only the calls made
 * here: a phase resumed from a checkpoint shows the part run now, and one
 * skipped as already measured does not appear.
 */
function printSpend(ledger: SpendLedger, c: Palette) {
  const rows = ledger.rows()
  if (rows.length === 0) {
    console.log(
      `\n${box([c.dim("No model calls were made.")], c, "what this run spent")}`
    )
    return
  }
  const { head, body, total } = spendTable(rows, { money, tokens: compact })
  const all = [head, ...body, total]
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, i) =>
        i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])
      )
      .join("  ")
  const unpriced = spendTotal(rows).unpriced
  console.log(
    `\n${box(
      [
        c.dim(line(head)),
        ...body.map((r) => (r[1] === "all phases" ? c.dim(line(r)) : line(r))),
        c.bold(line(total)),
        ...(unpriced.length
          ? [
              c.yellow(
                `No price for ${unpriced.join(", ")}: its tokens are counted and its cost is not, so the total is a floor.`
              ),
            ]
          : []),
        c.dim(
          "Not counted: the two small verification calls a model gets before its first phase."
        ),
      ],
      c,
      "what this run spent"
    )}`
  )
}

// --- main -------------------------------------------------------------------

function sample(documents: LabelledDocument[], n: number): LabelledDocument[] {
  if (documents.length <= n) return documents
  const step = documents.length / n
  return Array.from({ length: n }, (_, i) => documents[Math.floor(i * step)])
}

async function main() {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      phases: { type: "string" },
      corpus: {
        type: "string",
        default: path.join(HERE, "corpus", "synthetic-v1"),
      },
      split: { type: "string" },
      format: { type: "string", default: "text" },
      ids: { type: "string" },
      limit: { type: "string" },
      seed: { type: "string", default: "1" },
      concurrency: { type: "string", default: "4" },
      sweep: { type: "string", default: "1,2,4,8" },
      "sweep-documents": { type: "string", default: "24" },
      replace: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return
  }
  const c = palette()

  // The benchmark's environment, before anything reads one. A list given in
  // the shell is noted first, because the saved file fills in what the shell
  // leaves unset.
  const listedInShell = values.models ?? process.env.BENCH_MODELS
  const saved = await loadBenchEnv()

  const format = values.format
  if (format !== "text" && !isRenderFormat(format))
    throw new Error(
      `--format must be text or one of ${RENDER_FORMATS.join(", ")}, not ${JSON.stringify(format)}`
    )
  if (values.split !== undefined) parseSplit(values.split)
  const checkPhases = (list: string) => {
    const phases = list
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
    for (const phase of phases)
      if (!(PHASES as readonly string[]).includes(phase))
        throw new Error(
          `--phases takes ${PHASES.join(", ")}, not ${JSON.stringify(phase)}`
        )
    return phases
  }
  if (values.phases !== undefined) checkPhases(values.phases)

  const root = path.resolve(values.corpus)
  const corpus = path.basename(root)
  let documents = await loadCorpus(root, "all")
  const hash = await corpusHash(root)

  // Every call is tallied from the first, and a ChatGPT sign-in is read from
  // the benchmark's own store rather than the instance's database.
  liftSpendCap()
  const ledger = new SpendLedger()
  const live: { current: BenchDashboard | null } = { current: null }
  const usage = await captureUsage(
    (row) => {
      ledger.record(row)
      live.current?.call(
        row.documentId,
        row.task,
        row.inputTokens,
        row.outputTokens
      )
    },
    { setting: fileSettingStore() }
  )

  const interactive =
    Boolean(process.stdin.isTTY) && !values.yes && !process.env.CI
  let split = values.split ?? "test"
  let limit =
    values.limit !== undefined ? int("limit", values.limit, 1) : undefined
  let phaseList = values.phases ?? PHASES.join(",")
  let entries: ModelEntry[]
  {
    const { askCorpus, askModels, PHASE_CHOICES } = await import("./lib/setup")
    const { note, ok, Prompter, say } = await import("@/scripts/tty")
    const prompt = new Prompter(interactive)
    const onInterrupt = () => {
      prompt.close()
      console.log(c.yellow("\nStopped before anything was run."))
      process.exit(130)
    }
    process.on("SIGINT", onInterrupt)
    try {
      if (interactive) {
        const archive = `${root}.tar.gz`
        const answer = await askCorpus(
          prompt,
          {
            name: corpus,
            archive: existsSync(archive)
              ? path.relative(process.cwd(), archive).replace(/\\/g, "/")
              : null,
            hash,
            counts: {
              test: documents.filter((d) => d.split === "test").length,
              dev: documents.filter((d) => d.split === "dev").length,
            },
          },
          {
            split: values.split,
            askLimit: limit === undefined && values.ids === undefined,
          }
        )
        split = answer.split
        limit ??= answer.limit
        if (values.phases === undefined)
          phaseList = await prompt.choose("Which phases?", PHASE_CHOICES)
      }

      const savedList = saved.get("BENCH_MODELS")?.trim()
      if (listedInShell?.trim()) entries = parseModels(listedInShell)
      else if (interactive) {
        let reuse = false
        if (savedList) {
          say()
          say(`  ${c.bold("Saved models")} ${c.dim(`(${ENV_NAME})`)}`)
          for (const entry of parseModels(savedList))
            say(`    ${entry.provider}:${entry.model}`)
          reuse = await prompt.choose("Which models?", [
            { value: true, label: "These" },
            {
              value: false,
              label: "Choose providers and models again",
              detail: ["Saved keys are offered again; Enter keeps one."],
            },
          ])
        }
        if (reuse) entries = parseModels(savedList!)
        else {
          const chosen = await askModels(prompt, process.env)
          entries = chosen.entries
          await saveBenchEnv(chosen.updates)
          say()
          ok(`Saved to ${ENV_NAME}, for the benchmark only.`)
          note(".env, and everything the instance uses, are unchanged.")
        }
      } else if (savedList) entries = parseModels(savedList)
      else
        throw new Error(
          `No models to benchmark. Run pnpm bench:models in a terminal to choose them, or set BENCH_MODELS, with each provider's key, in ${ENV_NAME} or the shell.`
        )
    } finally {
      process.off("SIGINT", onInterrupt)
      prompt.close()
    }
  }

  const phases = checkPhases(phaseList)
  const options: Options = {
    split: parseSplit(split),
    format,
    concurrency: int("concurrency", values.concurrency, 1),
    sweep: values.sweep.split(",").map((v) => int("sweep", v.trim(), 1)),
    sweepDocuments: int("sweep-documents", values["sweep-documents"], 1),
    replace: values.replace,
    fresh: values.fresh,
  }

  if (options.split !== "all")
    documents = documents.filter((d) => d.split === options.split)
  if (format !== "text")
    documents = documents.filter((d) => d.render.includes(format))
  const of = documents.length
  const seed = int("seed", values.seed, 0)
  if (values.ids) {
    const wanted = new Set(values.ids.split(",").map((id) => id.trim()))
    documents = documents.filter((d) => wanted.has(d.id))
  }
  documents.sort((a, b) => a.id.localeCompare(b.id))
  const sampled = limit !== undefined && limit < documents.length
  if (sampled) documents = stratifiedSample(documents, limit!, seed)
  if (documents.length === 0) throw new Error("no documents to run")
  const selection: Selection = values.ids
    ? { how: "ids", documents: documents.length, of }
    : sampled
      ? { how: "stratified", documents: documents.length, of, seed }
      : { how: "all", documents: documents.length, of }

  const directory = path.join(
    RESULTS,
    resultsDirectory(corpus, options.split, format)
  )
  const partial = selection.how !== "all"

  console.log(
    `\n${box(
      [
        `${c.dim("corpus")} ${corpus} ${c.dim(`(${hash?.slice(7, 19) ?? "no manifest"}…)`)}  ${c.dim("split")} ${options.split}  ${c.dim("format")} ${format}  ${c.dim("documents")} ${documents.length}`,
        `${c.dim("models")} ${entries.map((e) => `${e.provider}:${e.model}`).join(", ")}`,
        `${c.dim("phases")} ${phases.join(" → ")}  ${c.dim("concurrency")} ${options.concurrency}${phases.includes("throughput") ? `  ${c.dim("sweep")} ${options.sweep.join(", ")} × ${Math.min(options.sweepDocuments, documents.length)} documents` : ""}`,
        `${c.dim("environment")} ${ENV_NAME}  ${c.dim("results")} ${path.relative(process.cwd(), directory)}`,
        ...(partial
          ? [
              c.yellow(
                selection.how === "stratified"
                  ? `a partial run: ${selection.documents} of ${selection.of}, stratified by document type (seed ${selection.seed})`
                  : `a partial run: the ${selection.documents} of ${selection.of} documents --ids names`
              ),
            ]
          : []),
      ],
      c,
      "bench:models"
    )}`
  )

  const { aiConfigured, resolveModel } = await import("@/lib/ai/gateway")
  const { configuredRates } = await import("@/lib/ai/rates")
  const fingerprint = await promptFingerprint()

  process.on("SIGINT", () => {
    if (stopping) process.exit(130)
    stopping = true
    live.current?.setNote(
      "stopping after the documents in flight; ctrl+c again to quit now"
    )
  })

  for (const entry of entries) {
    if (stopping) break
    selectModel(entry.provider, entry.model)
    const model = resolveModel()
    const file = path.join(directory, `${modelSlug(model)}.json`)
    console.log(`\n${c.bold(entry.label)} ${c.dim(`(${model})`)}`)
    if (!aiConfigured()) {
      console.log(
        c.red(
          `  ${entry.provider} is not configured: run pnpm bench:models in a terminal to set it up, or set its key in ${ENV_NAME}. Skipped.`
        )
      )
      process.exitCode = 1
      continue
    }
    if (!(await ensureVerified(entry, c, values["dry-run"]))) {
      console.log(c.red("  Skipped."))
      process.exitCode = 1
      continue
    }
    const rates = configuredRates(model)
    if (!rates)
      console.log(
        c.yellow(
          `  No price for ${model}: tokens are counted, cost is left empty. Add it to AI_MODEL_PRICES in ${ENV_NAME} to price it.`
        )
      )

    let results = await readResults(file)
    if (results && results.corpusHash !== hash) {
      if (!options.replace) {
        console.log(
          c.yellow(
            `  ${path.relative(process.cwd(), file)} was measured on another version of the corpus; --replace to measure it again on this one. Skipped.`
          )
        )
        continue
      }
      results = null
    }
    results ??= {
      schema: BENCH_SCHEMA,
      model,
      provider: entry.provider,
      label: entry.label,
      firstMeasuredAt: new Date().toISOString(),
      corpus,
      corpusHash: hash,
      split: options.split,
      format,
      rates,
      commit: null,
      createdAt: new Date().toISOString(),
      documents: 0,
      deterministicFirst: true,
      totals: null,
      perDocument: null,
      quality: null,
      runs: {},
      throughput: null,
      settings: { aiRequestsPerMinute: null, aiMaxAttempts: null },
      notMeasured: notMeasured(format),
    }
    results.label = entry.label
    results.rates = rates
    results.settings = {
      aiRequestsPerMinute: process.env.ANONIFY_AI_REQUESTS_PER_MINUTE ?? null,
      aiMaxAttempts: process.env.ANONIFY_AI_MAX_ATTEMPTS ?? null,
    }

    for (const phase of phases as Phase[]) {
      if (stopping) break
      const measured =
        phase === "throughput"
          ? results.throughput !== null
          : results.runs[phase] !== undefined
      if (measured && !options.replace) {
        console.log(
          c.dim(`  ${phase}: already measured; --replace to measure it again`)
        )
        continue
      }
      if (values["dry-run"]) {
        console.log(`  ${phase}: ${c.cyan("would run")}`)
        continue
      }

      if (phase === "throughput") {
        const picked = sample(documents, options.sweepDocuments)
        const points = []
        const previous = process.env.ANONIFY_AI_CONCURRENCY
        for (const level of options.sweep) {
          if (stopping) break
          process.env.ANONIFY_AI_CONCURRENCY = String(level)
          ledger.begin({ label: entry.label, model, phase, rates })
          const run = await runPhase({
            mode: "deterministic-first",
            documents: picked,
            concurrency: level,
            format: "text",
            rates,
            usage,
            checkpoint: null,
            header: {},
            fresh: true,
            onCall: live,
            title: `${entry.label} · throughput at ${level} at once`,
          })
          if (!run) break
          const point = throughputPoint(
            level,
            run.records,
            run.durationMs,
            rates
          )
          points.push(point)
          console.log(
            `  ${c.dim("concurrency")} ${String(level).padStart(2)}  ${c.bold(point.documentsPerMinute.toFixed(1))} ${c.dim("docs/min")}  ${point.callsPerMinute} ${c.dim("calls/min")}  ${c.dim("p95")} ${(point.p95Ms / 1000).toFixed(1)}s${
              Object.keys(point.degraded).length
                ? c.yellow(
                    `  cut short: ${Object.entries(point.degraded)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(", ")}`
                  )
                : ""
            }`
          )
        }
        if (previous === undefined) delete process.env.ANONIFY_AI_CONCURRENCY
        else process.env.ANONIFY_AI_CONCURRENCY = previous
        if (stopping) break
        results.throughput = { documents: picked.map((d) => d.id), points }
      } else {
        const header = {
          corpusHash: hash,
          split: options.split,
          format,
          model,
          mode: phase,
          documents: documents.length,
        }
        const checkpoint = path.join(
          CHECKPOINTS,
          resultsDirectory(corpus, options.split, format),
          `${modelSlug(model)}.${phase}.jsonl`
        )
        ledger.begin({ label: entry.label, model, phase, rates })
        const run = await runPhase({
          mode: phase,
          documents,
          concurrency: options.concurrency,
          format,
          rates,
          usage,
          checkpoint,
          header,
          fresh: options.fresh,
          onCall: live,
          title: `${entry.label} · ${phase}`,
        })
        if (!run) break
        const summary = summarise({
          mode: phase,
          records: run.records,
          failed: run.failed,
          documents,
          rates,
          durationMs: run.durationMs,
          concurrency: options.concurrency,
          commit: gitCommit(),
        })
        results.runs[phase] = { ...summary, selection, fingerprint }
        printRun(
          results.runs[phase]!,
          c,
          phase === "model-only"
            ? results.runs["deterministic-first"]
            : undefined
        )
        await rm(checkpoint, { force: true })
      }

      results = withHeadline({
        ...results,
        createdAt: new Date().toISOString(),
      })
      await mkdir(directory, { recursive: true })
      await writeFile(file, serialise(results))
      console.log(c.dim(`  ${path.relative(process.cwd(), file)}`))
    }
  }

  if (!values["dry-run"]) printSpend(ledger, c)
  if (stopping) {
    console.log(
      c.yellow(
        limitedBy
          ? `\nStopped: the provider cut the model pass short (${limitedBy}), so nothing more was recorded and no results file was written for this phase. Every finished document is checkpointed; run the same command again once the limit clears.`
          : "\nStopped. Every finished document is checkpointed; run the same command again to resume."
      )
    )
    process.exitCode = 130
    return
  }
  if (!values["dry-run"]) {
    await printTable(directory, c)
    console.log(
      c.dim("\n  pnpm bench:charts redraws the charts from these files.")
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
