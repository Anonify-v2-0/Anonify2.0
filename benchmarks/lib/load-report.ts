import { LOAD_FORMATS } from "../load/fixtures"
import type { Distribution, Scenario, Summary } from "../load/scenarios"
import { both, picture, table, type Chart } from "./report"
import { logBars, lines, stacked } from "./svg"

/**
 * Charts of the committed load-test results (#241, #190).
 *
 * `pnpm load` writes `benchmarks/results/load-*.json`. These turn them into
 * the same light and dark SVGs as the model benchmark, and a generated
 * section of benchmarks/README.md:
 *
 * - **Throughput per worker unit**, by format: for each unit size, the
 *   steady run that got the most through per worker, which is its capacity.
 * - **Time to ready against load**, by format, for one unit size: p95 at
 *   each reviewer count it was run at, which is where queueing shows.
 * - **Web-route latency** from the newest read-heavy run.
 *
 * Only runs against the stub provider are charted for throughput and time to
 * ready, so the numbers are Anonify's and not a vendor's; a run that lost a
 * document is left out and named, since what it measured was not a working
 * deployment. Nothing here is run: the charts say what the files say.
 */

export type LoadResult = {
  kind: "anonify-load"
  version: 1
  scenario: Scenario
  startedAt: string
  commit: string | null
  topology: {
    workers: number | null
    workerCpus: number | null
    workerMemory: string | null
    labels: Record<string, string>
  }
  options: { reviewers: number; formats: string[] }
  stub: unknown
  summary: Summary
}

export type LoadReport = {
  charts: Chart[]
  /** Charts not drawn, and what they need. */
  missing: { title: string; needs: string }[]
  /** Results left out, and why. */
  excluded: { file: string; reason: string }[]
  runs: number
}

export const LOAD_MARKERS = {
  start: "<!-- bench:load:start -->",
  end: "<!-- bench:load:end -->",
}

/** The unit time to ready is charted for, when it was measured. */
const REFERENCE_CPUS = 2

const minutes = (value: number) =>
  value >= 100 ? value.toFixed(0) : value.toFixed(1)
const seconds = (ms: number) =>
  ms >= 100_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`
const milliseconds = (ms: number) => `${Math.round(ms)}ms`

/** True when the file is a result this version of the charts reads. */
export function isLoadResult(value: unknown): value is LoadResult {
  const result = value as Partial<LoadResult> | null
  return (
    typeof result === "object" &&
    result !== null &&
    result.kind === "anonify-load" &&
    result.version === 1
  )
}

function unitLabel(result: LoadResult): string {
  const memory = result.topology.workerMemory
  return `${result.topology.workerCpus} vCPU${memory ? ` · ${memory}` : ""}`
}

function formatsOf(results: LoadResult[]): string[] {
  const seen = new Set(
    results.flatMap((result) => Object.keys(result.summary.byFormat))
  )
  return [
    ...LOAD_FORMATS.filter((format) => seen.has(format)),
    ...[...seen].filter(
      (format) => !(LOAD_FORMATS as readonly string[]).includes(format)
    ),
  ]
}

function slotOf(format: string): number {
  const at = (LOAD_FORMATS as readonly string[]).indexOf(format)
  return at === -1 ? LOAD_FORMATS.length : at
}

/** The steady stub run with the most documents per worker, per unit size. */
function capacityRuns(steady: LoadResult[]): LoadResult[] {
  const best = new Map<string, LoadResult>()
  for (const result of steady) {
    const perWorker = result.summary.throughput.perWorker
    if (!perWorker || result.topology.workerCpus === null) continue
    const key = unitLabel(result)
    const held = best.get(key)?.summary.throughput.perWorker
    if (!held || perWorker.documentsPerMinute > held.documentsPerMinute)
      best.set(key, result)
  }
  return [...best.values()].sort(
    (a, b) =>
      a.topology.workerCpus! - b.topology.workerCpus! ||
      unitLabel(a).localeCompare(unitLabel(b))
  )
}

function throughputChart(runs: LoadResult[]): Chart {
  const formats = formatsOf(runs)
  // Pages, not documents, by format: every batch has one document of each
  // format, so documents split evenly and say nothing about where the work is.
  const rows = runs.map((result) => {
    const workers = result.topology.workers!
    const perWorker = result.summary.throughput.perWorker!
    return {
      label: `${unitLabel(result)} · ${minutes(perWorker.documentsPerMinute)} docs`,
      segments: formats.map(
        (format) =>
          (result.summary.byFormat[format]?.pagesPerMinute ?? 0) / workers
      ),
      total: `${minutes(perWorker.pagesPerMinute)}/min`,
    }
  })
  const chart = {
    title: "Throughput per worker unit",
    subtitle:
      "Pages a minute one worker of each size finished, by format, at its busiest steady run; documents a minute by its size",
    note: "Stub provider, so the time is Anonify's own. Each unit's best steady run; the table has its reviewers and workers.",
    series: formats,
    slots: formats.map(slotOf),
    panels: [{ rows }],
    format: minutes,
  }
  return {
    name: "load-throughput",
    title: chart.title,
    alt: `${chart.title}: ${rows.map((row) => `${row.label} a minute, ${row.total} pages`).join("; ")}.`,
    reading:
      "Each bar is one worker of that size, so N workers handle about N times the bar. The segments are the pages of each format in the mix the run uploaded, one document of each per batch.",
    svg: both((theme) => stacked(theme, chart)),
    table: table(
      [
        "Worker unit",
        "Documents/min",
        "Pages/min",
        ...formats.map((format) => `${format} pages/min`),
        "Workers",
        "Reviewers",
        "Commit",
      ],
      runs.map((result) => {
        const workers = result.topology.workers!
        const perWorker = result.summary.throughput.perWorker!
        return [
          unitLabel(result),
          minutes(perWorker.documentsPerMinute),
          minutes(perWorker.pagesPerMinute),
          ...formats.map((format) => {
            const entry = result.summary.byFormat[format]
            return entry ? minutes(entry.pagesPerMinute / workers) : "–"
          }),
          String(workers),
          String(result.options.reviewers),
          result.commit ? `\`${result.commit.slice(0, 7)}\`` : "–",
        ]
      })
    ),
  }
}

/** Steady runs of one unit, one per reviewer count (the newest), by load. */
function loadLevels(steady: LoadResult[]): LoadResult[] | null {
  const units = new Map<number, LoadResult[]>()
  for (const result of steady) {
    const cpus = result.topology.workerCpus
    if (cpus === null) continue
    units.set(cpus, [...(units.get(cpus) ?? []), result])
  }
  const chosen =
    units.get(REFERENCE_CPUS) ??
    [...units.values()].sort((a, b) => b.length - a.length)[0]
  if (!chosen) return null
  const byReviewers = new Map<number, LoadResult>()
  for (const result of chosen.sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt)
  ))
    byReviewers.set(result.options.reviewers, result)
  return [...byReviewers.values()].sort(
    (a, b) => a.options.reviewers - b.options.reviewers
  )
}

function timeToReadyChart(levels: LoadResult[]): Chart {
  const formats = formatsOf(levels)
  const unit = unitLabel(levels[0])
  const timing = (result: LoadResult, format: string): Distribution | null => {
    const entry = result.summary.byFormat[format]
    return entry && entry.timeToReadyMs.count > 0 ? entry.timeToReadyMs : null
  }
  const chart = {
    title: "Time to ready against load",
    subtitle: `p95 from starting a run to the document being ready, ${unit} workers, by reviewers working at once`,
    note: "Stub provider. A line that bends upward is the queue growing: past that many reviewers, add a worker.",
    x: levels.map((result) => String(result.options.reviewers)),
    xLabel: "reviewers",
    yLabel: "seconds",
    series: formats.map((format) => ({
      label: format,
      slot: slotOf(format),
      values: levels.map((result) => {
        const t = timing(result, format)
        return t ? t.p95 / 1000 : null
      }),
    })),
    format: (value: number) => `${value.toFixed(value >= 100 ? 0 : 1)}s`,
  }
  return {
    name: "load-time-to-ready",
    title: chart.title,
    alt: `${chart.title}, ${unit}: ${chart.series.map((s) => `${s.label} ${s.values.map((v, i) => `${chart.x[i]} reviewers ${v === null ? "not measured" : chart.format(v)}`).join(", ")}`).join("; ")}.`,
    reading:
      "Flat lines mean the workers keep up and a document waits only for its own processing. The p50 is in the table.",
    svg: both((theme) => lines(theme, chart)),
    table: table(
      [
        "Reviewers",
        "Workers",
        ...formats.map((format) => `${format} p50 / p95`),
      ],
      levels.map((result) => [
        String(result.options.reviewers),
        String(result.topology.workers ?? "–"),
        ...formats.map((format) => {
          const t = timing(result, format)
          return t ? `${seconds(t.p50)} / ${seconds(t.p95)}` : "–"
        }),
      ])
    ),
  }
}

/** Routes asked often enough for a p95 to mean something. */
const MIN_REQUESTS = 20

function latencyChart(result: LoadResult): Chart | null {
  const routes = Object.entries(result.summary.routes)
    .filter(([, timing]) => timing.count >= MIN_REQUESTS)
    .sort(([, a], [, b]) => b.p95 - a.p95)
  if (routes.length === 0) return null
  const chart = {
    title: "Web-route latency while reading",
    subtitle: `${result.options.reviewers} reviewers listing, opening pages, reading suggestions and searching, nothing processing`,
    note: `To the last byte, from the harness. Routes asked at least ${MIN_REQUESTS} times; log scale.`,
    series: ["p50", "p95"],
    rows: routes.map(([route, timing]) => ({
      label: route,
      values: [Math.max(1, timing.p50), Math.max(1, timing.p95)],
    })),
    format: milliseconds,
  }
  return {
    name: "load-web-latency",
    title: chart.title,
    alt: `${chart.title}: ${routes.map(([route, t]) => `${route} p50 ${t.p50}ms, p95 ${t.p95}ms`).join("; ")}.`,
    reading:
      "What a reviewer waits for on each kind of request while the web role is busy serving others.",
    svg: both((theme) => logBars(theme, chart)),
    table: table(
      ["Route", "Requests", "p50", "p95", "p99"],
      routes.map(([route, t]) => [
        `\`${route}\``,
        String(t.count),
        milliseconds(t.p50),
        milliseconds(t.p95),
        milliseconds(t.p99),
      ])
    ),
  }
}

export function buildLoadReport(
  files: { file: string; result: LoadResult }[]
): LoadReport {
  const excluded: LoadReport["excluded"] = []
  const usable = files.filter(({ file, result }) => {
    if (result.summary.documents.lost > 0) {
      excluded.push({
        file,
        reason: `${result.summary.documents.lost} document(s) lost, so it did not measure a working deployment`,
      })
      return false
    }
    return true
  })
  const steady = usable
    .map(({ result }) => result)
    .filter((result) => result.scenario === "steady" && result.stub)

  const charts: Chart[] = []
  const missing: LoadReport["missing"] = []

  const capacity = capacityRuns(steady)
  if (capacity.length > 0) charts.push(throughputChart(capacity))
  else
    missing.push({
      title: "Throughput per worker unit",
      needs:
        "a steady run with --stub, --workers and --worker-cpus (pnpm load steady --stub --workers 2 --worker-cpus 2)",
    })

  const levels = loadLevels(steady)
  if (levels && levels.length >= 2) charts.push(timeToReadyChart(levels))
  else
    missing.push({
      title: "Time to ready against load",
      needs:
        "steady runs with --stub at two or more --reviewers counts on one worker unit",
    })

  const reading = usable
    .map(({ result }) => result)
    .filter((result) => result.scenario === "read-heavy")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  const latency = reading ? latencyChart(reading) : null
  if (latency) charts.push(latency)
  else
    missing.push({
      title: "Web-route latency while reading",
      needs: "a read-heavy run (pnpm load read-heavy)",
    })

  return { charts, missing, excluded, runs: files.length }
}

/** The generated section of benchmarks/README.md, under "Load testing". */
export function loadMarkdown(report: LoadReport): string {
  const out: string[] = [
    LOAD_MARKERS.start,
    "<!-- Generated by `pnpm bench:charts` from `benchmarks/results/load-*.json`. Edits here are overwritten. -->",
    "",
  ]
  if (report.runs === 0) {
    out.push(
      "No load results are committed yet. They are to come from runs on dedicated machines (#240): a laptop shares its CPUs between the generator, the database and the workers, so a run there says how the harness behaves, not what a worker unit handles.",
      ""
    )
  }
  if (report.excluded.length > 0) {
    out.push(
      "> [!WARNING]",
      ...report.excluded.map(
        (entry) => `> - \`${entry.file}\` is left out: ${entry.reason}.`
      ),
      ""
    )
  }
  for (const chart of report.charts) {
    out.push(
      `#### ${chart.title}`,
      "",
      chart.reading,
      "",
      picture(chart, "charts/"),
      "",
      "<details><summary>The numbers</summary>",
      "",
      chart.table,
      "",
      "</details>",
      ""
    )
  }
  if (report.runs > 0 && report.missing.length > 0) {
    out.push(
      "Not drawn yet:",
      "",
      ...report.missing.map(
        (entry) => `- ${entry.title}: needs ${entry.needs}.`
      ),
      ""
    )
  }
  out.push(LOAD_MARKERS.end)
  return out.join("\n")
}
