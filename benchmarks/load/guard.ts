/**
 * The nightly throughput guard (#242).
 *
 *   pnpm load:guard <result.json>                     # compare with the baseline
 *   pnpm load:guard --write-baseline <result.json>…   # make one from several runs
 *
 * Compares one `pnpm load steady --stub` result with
 * `benchmarks/results/load-baseline.json` and exits 1 if documents a minute
 * fell more than the baseline's threshold (20%) below it, or if any document
 * was lost. Without a baseline it reports the run and passes, so the first
 * few nightly runs can become one: download their results from the workflow
 * and pass them all to `--write-baseline`, which takes their median.
 *
 * The run and the baseline must be the same load on the same topology, or
 * the comparison means nothing; a mismatch is an error, not a pass.
 */

import { existsSync } from "node:fs"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { isLoadResult, type LoadResult } from "../lib/load-report"

const BASELINE = path.join(
  import.meta.dirname,
  "..",
  "results",
  "load-baseline.json"
)
const DEFAULT_THRESHOLD = 0.2

export type LoadBaseline = {
  kind: "anonify-load-baseline"
  version: 1
  scenario: LoadResult["scenario"]
  /** What a run must match to be compared. */
  shape: Shape
  documentsPerMinute: number
  /** The drop, as a share, past which a run fails. */
  threshold: number
  runs: {
    startedAt: string
    commit: string | null
    documentsPerMinute: number
  }[]
}

type Shape = {
  workers: number | null
  workerCpus: number | null
  workerMemory: string | null
  reviewers: number
  formats: string[]
}

export function shapeOf(result: LoadResult): Shape {
  return {
    workers: result.topology.workers,
    workerCpus: result.topology.workerCpus,
    workerMemory: result.topology.workerMemory,
    reviewers: result.options.reviewers,
    formats: [...result.options.formats].sort(),
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

export function makeBaseline(
  results: LoadResult[],
  threshold = DEFAULT_THRESHOLD
): LoadBaseline {
  if (results.length === 0) throw new Error("no results to make a baseline of")
  const shape = shapeOf(results[0])
  for (const result of results) {
    if (result.scenario !== results[0].scenario)
      throw new Error("the results are of different scenarios")
    if (JSON.stringify(shapeOf(result)) !== JSON.stringify(shape))
      throw new Error(
        `the results ran different loads: ${JSON.stringify(shapeOf(result))} against ${JSON.stringify(shape)}`
      )
    if (result.summary.documents.lost > 0)
      throw new Error(
        `the run of ${result.startedAt} lost documents; it is no baseline`
      )
  }
  return {
    kind: "anonify-load-baseline",
    version: 1,
    scenario: results[0].scenario,
    shape,
    documentsPerMinute: median(
      results.map((result) => result.summary.throughput.documentsPerMinute)
    ),
    threshold,
    runs: results.map((result) => ({
      startedAt: result.startedAt,
      commit: result.commit,
      documentsPerMinute: result.summary.throughput.documentsPerMinute,
    })),
  }
}

export type Verdict = {
  passed: boolean
  lines: string[]
}

export function judge(
  result: LoadResult,
  baseline: LoadBaseline | null
): Verdict {
  const lines: string[] = []
  let passed = true
  const { documents, throughput } = result.summary

  if (documents.lost > 0) {
    passed = false
    lines.push(`✗ ${documents.lost} document(s) were lost`)
  } else lines.push(`✓ no document lost (${documents.ready} ready)`)
  if (documents.failed > 0)
    lines.push(
      `! ${documents.failed} document(s) failed: ${JSON.stringify(documents.failures)}`
    )

  if (!baseline) {
    lines.push(
      `· ${throughput.documentsPerMinute} documents a minute; no baseline yet, so nothing to compare with`,
      "  Make one from a few nightly results: pnpm load:guard --write-baseline <result.json>…"
    )
    return { passed, lines }
  }

  if (result.scenario !== baseline.scenario) {
    lines.push(
      `✗ the run is ${result.scenario}, the baseline ${baseline.scenario}`
    )
    return { passed: false, lines }
  }
  const shape = shapeOf(result)
  if (JSON.stringify(shape) !== JSON.stringify(baseline.shape)) {
    lines.push(
      `✗ the run is not the load the baseline measured: ${JSON.stringify(shape)} against ${JSON.stringify(baseline.shape)}`
    )
    return { passed: false, lines }
  }

  const floor = baseline.documentsPerMinute * (1 - baseline.threshold)
  const change =
    (throughput.documentsPerMinute - baseline.documentsPerMinute) /
    baseline.documentsPerMinute
  const described = `${throughput.documentsPerMinute} documents a minute against a baseline of ${baseline.documentsPerMinute} (${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%)`
  if (throughput.documentsPerMinute < floor) {
    passed = false
    lines.push(
      `✗ ${described}: more than ${Math.round(baseline.threshold * 100)}% below it`
    )
  } else lines.push(`✓ ${described}`)
  return { passed, lines }
}

async function readResult(file: string): Promise<LoadResult> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
  if (!isLoadResult(parsed))
    throw new Error(`${file} is not a pnpm load result (version 1)`)
  return parsed
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "write-baseline": { type: "boolean", default: false },
      baseline: { type: "string", default: BASELINE },
      threshold: { type: "string" },
    },
  })
  if (positionals.length === 0)
    throw new Error(
      "usage: pnpm load:guard <result.json> | --write-baseline <result.json>…"
    )

  if (values["write-baseline"]) {
    const threshold =
      values.threshold === undefined
        ? DEFAULT_THRESHOLD
        : Number(values.threshold)
    if (!(threshold > 0 && threshold < 1))
      throw new Error("--threshold is a share between 0 and 1, such as 0.2")
    const baseline = makeBaseline(
      await Promise.all(positionals.map(readResult)),
      threshold
    )
    await writeFile(values.baseline, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(
      `wrote ${path.relative(process.cwd(), values.baseline)}: ${baseline.documentsPerMinute} documents a minute, the median of ${baseline.runs.length} run(s)`
    )
    return
  }

  const result = await readResult(positionals[0])
  const baseline = existsSync(values.baseline)
    ? (JSON.parse(await readFile(values.baseline, "utf8")) as LoadBaseline)
    : null
  const verdict = judge(result, baseline)
  console.log(verdict.lines.join("\n"))

  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary)
    await appendFile(
      summary,
      [
        "## Load-test guard",
        "",
        ...verdict.lines.map((line) => `    ${line}`),
        "",
      ].join("\n")
    )
  if (!verdict.passed) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
