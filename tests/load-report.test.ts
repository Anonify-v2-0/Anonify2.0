import { describe, expect, it } from "vitest"

import { judge, makeBaseline } from "@/benchmarks/load/guard"
import {
  buildLoadReport,
  isLoadResult,
  LOAD_MARKERS,
  loadMarkdown,
  type LoadResult,
} from "@/benchmarks/lib/load-report"

/**
 * The load-test charts (#241), from results shaped as `pnpm load` writes them.
 * What is charted is a choice about the data, so the choices are what is
 * tested: which run stands for a unit's capacity, which runs are left out.
 */

const timing = (p50: number, p95: number) => ({
  count: 30,
  p50,
  p95,
  p99: p95,
  max: p95,
})

let clock = Date.parse("2026-10-11T00:00:00Z")

function result(input: {
  scenario?: LoadResult["scenario"]
  cpus?: number | null
  workers?: number | null
  reviewers?: number
  documentsPerMinute?: number
  stub?: boolean
  lost?: number
  routes?: Record<string, ReturnType<typeof timing>>
}): LoadResult {
  const workers = input.workers === undefined ? 2 : input.workers
  const documentsPerMinute = input.documentsPerMinute ?? 10
  const byFormat = Object.fromEntries(
    ["pdf", "scan"].map((format) => [
      format,
      {
        ready: 20,
        failed: 0,
        documentsPerMinute: documentsPerMinute / 2,
        pagesPerMinute: documentsPerMinute * 3,
        timeToReadyMs: timing(4000 * (input.reviewers ?? 4), 9000),
      },
    ])
  )
  clock += 60_000
  return {
    kind: "anonify-load",
    version: 1,
    scenario: input.scenario ?? "steady",
    startedAt: new Date(clock).toISOString(),
    commit: "0123456789abcdef",
    topology: {
      workers,
      workerCpus: input.cpus === undefined ? 2 : input.cpus,
      workerMemory: "4g",
      labels: {},
    },
    options: { reviewers: input.reviewers ?? 4, formats: ["pdf", "scan"] },
    stub: input.stub === false ? null : { latencyMs: 800 },
    summary: {
      window: { from: new Date(clock).toISOString(), seconds: 240 },
      documents: {
        started: 40,
        ready: 40,
        failed: 0,
        lost: input.lost ?? 0,
        refusedAtReservation: 0,
        degradedAnalyses: 0,
        failures: {},
      },
      throughput: {
        documentsPerMinute,
        pagesPerMinute: documentsPerMinute * 6,
        perWorker: workers
          ? {
              documentsPerMinute: documentsPerMinute / workers,
              pagesPerMinute: (documentsPerMinute * 6) / workers,
            }
          : null,
        drainSeconds: 300,
      },
      byFormat,
      exportMs: timing(500, 900),
      sseLagMs: timing(5, 20),
      routes: input.routes ?? {},
      httpFailures: {},
      throttled: {},
      errors: {},
      events: [],
      lost: [],
    },
  }
}

const named = (results: LoadResult[]) =>
  results.map((entry, at) => ({
    file: `benchmarks/results/load-${at}.json`,
    result: entry,
  }))

describe("load charts", () => {
  it("reads only results of the version it knows", () => {
    expect(isLoadResult(result({}))).toBe(true)
    expect(isLoadResult({ kind: "anonify-load", version: 2 })).toBe(false)
    expect(isLoadResult({ baseline: true })).toBe(false)
  })

  it("draws nothing, and says why, before any result is committed", () => {
    const report = buildLoadReport([])
    expect(report.charts).toEqual([])
    expect(report.missing).toHaveLength(3)
    const markdown = loadMarkdown(report)
    expect(markdown.startsWith(LOAD_MARKERS.start)).toBe(true)
    expect(markdown.endsWith(LOAD_MARKERS.end)).toBe(true)
    expect(markdown).toContain("#240")
  })

  it("takes each unit's busiest steady stub run as its capacity", () => {
    const report = buildLoadReport(
      named([
        result({ cpus: 2, reviewers: 4, documentsPerMinute: 10 }),
        result({ cpus: 2, reviewers: 8, documentsPerMinute: 18 }),
        result({ cpus: 2, reviewers: 16, documentsPerMinute: 16 }),
        result({ cpus: 1, reviewers: 4, documentsPerMinute: 6 }),
        // A real provider is a vendor's latency, not a unit's capacity.
        result({ cpus: 2, reviewers: 32, documentsPerMinute: 40, stub: false }),
      ])
    )
    const throughput = report.charts.find(
      (chart) => chart.name === "load-throughput"
    )!
    const rows = throughput.table.split("\n").slice(2)
    expect(rows).toHaveLength(2)
    // Smallest unit first; 18 documents a minute over two workers is 9.
    expect(rows[0]).toMatch(/^\| 1 vCPU · 4g \| 3\.0 \|/)
    expect(rows[1]).toMatch(/^\| 2 vCPU · 4g \| 9\.0 \|.*\| 8 \|/)
    expect(throughput.svg.light).toContain("<svg")
    expect(throughput.svg.dark).toContain("<svg")
  })

  it("charts time to ready by reviewers on the 2 vCPU unit", () => {
    const report = buildLoadReport(
      named([
        result({ cpus: 1, reviewers: 2 }),
        result({ cpus: 1, reviewers: 4 }),
        result({ cpus: 1, reviewers: 8 }),
        result({ cpus: 2, reviewers: 8 }),
        result({ cpus: 2, reviewers: 4 }),
      ])
    )
    const chart = report.charts.find(
      (entry) => entry.name === "load-time-to-ready"
    )!
    expect(chart.alt).toContain("2 vCPU")
    const reviewers = chart.table
      .split("\n")
      .slice(2)
      .map((row) => row.split("|")[1].trim())
    expect(reviewers).toEqual(["4", "8"])
  })

  it("needs two load levels before drawing time to ready", () => {
    const report = buildLoadReport(named([result({ reviewers: 4 })]))
    expect(report.charts.map((chart) => chart.name)).not.toContain(
      "load-time-to-ready"
    )
    expect(report.missing.map((entry) => entry.title)).toContain(
      "Time to ready against load"
    )
  })

  it("leaves out a run that lost a document, and names it", () => {
    const report = buildLoadReport(
      named([result({ documentsPerMinute: 50, lost: 1 }), result({})])
    )
    expect(report.excluded).toEqual([
      {
        file: "benchmarks/results/load-0.json",
        reason:
          "1 document(s) lost, so it did not measure a working deployment",
      },
    ])
    expect(loadMarkdown(report)).toContain("load-0.json` is left out")
  })

  it("charts the newest read-heavy run's busy routes", () => {
    const report = buildLoadReport(
      named([
        result({
          scenario: "read-heavy",
          routes: { "GET /api/documents": timing(10, 30) },
        }),
        result({
          scenario: "read-heavy",
          routes: {
            "GET /api/documents": timing(12, 40),
            "GET /api/documents/:id/pages/:n": timing(25, 120),
            "GET /api/rare": { ...timing(1, 2), count: 3 },
          },
        }),
      ])
    )
    const chart = report.charts.find(
      (entry) => entry.name === "load-web-latency"
    )!
    // Slowest first; a route asked three times says nothing about a p95.
    expect(chart.table).toMatch(
      /`GET \/api\/documents\/:id\/pages\/:n`[\s\S]*`GET \/api\/documents`/
    )
    expect(chart.table).not.toContain("/api/rare")
    expect(chart.table).toContain("| 40ms |")
  })
})

describe("the nightly guard (#242)", () => {
  const nightly = (documentsPerMinute: number, lost = 0) =>
    result({ documentsPerMinute, lost, workers: 1, reviewers: 4 })

  it("takes the median of several runs as the baseline", () => {
    const baseline = makeBaseline([nightly(10), nightly(14), nightly(11)])
    expect(baseline.documentsPerMinute).toBe(11)
    expect(baseline.threshold).toBe(0.2)
    expect(baseline.runs).toHaveLength(3)
  })

  it("refuses a baseline from runs of different loads, or one that lost a document", () => {
    expect(() =>
      makeBaseline([nightly(10), result({ workers: 1, reviewers: 8 })])
    ).toThrow(/different loads/)
    expect(() => makeBaseline([nightly(10, 1)])).toThrow(/lost documents/)
  })

  it("passes within the threshold and fails past it", () => {
    const baseline = makeBaseline([nightly(10)])
    expect(judge(nightly(8.1), baseline).passed).toBe(true)
    const slow = judge(nightly(7.9), baseline)
    expect(slow.passed).toBe(false)
    expect(slow.lines.join("\n")).toMatch(/more than 20% below/)
  })

  it("fails on a lost document whatever the throughput", () => {
    const verdict = judge(nightly(50, 2), makeBaseline([nightly(10)]))
    expect(verdict.passed).toBe(false)
    expect(verdict.lines[0]).toMatch(/2 document\(s\) were lost/)
  })

  it("passes with no baseline, saying how to make one", () => {
    const verdict = judge(nightly(10), null)
    expect(verdict.passed).toBe(true)
    expect(verdict.lines.join("\n")).toContain("--write-baseline")
  })

  it("does not compare a run with a baseline of a different load", () => {
    const verdict = judge(
      result({ documentsPerMinute: 10, workers: 2, reviewers: 4 }),
      makeBaseline([nightly(10)])
    )
    expect(verdict.passed).toBe(false)
    expect(verdict.lines.join("\n")).toMatch(
      /not the load the baseline measured/
    )
  })
})
