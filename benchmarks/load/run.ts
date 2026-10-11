/**
 * Load tests against a running Anonify (#190).
 *
 *   pnpm load stub                                   # the stub provider on its own
 *   pnpm load steady http://localhost:3000 --stub --docker anonify
 *   pnpm load burst https://anonify.example.com --documents 200 --window 60
 *   pnpm load read-heavy http://localhost:3000 --reviewers 50
 *   pnpm load scale-in http://localhost:3000 --stub --docker anonify
 *
 * Works against any URL, a cloud deployment included: everything it does is
 * through the HTTP API, as a browser. What it cannot see from outside (CPU,
 * memory, queue depth) comes from the deployment's own metrics (#188) when
 * `--metrics` or `--docker` say where they are.
 *
 * Each run writes benchmarks/results/load-<scenario>-<time>.json: the options,
 * the topology it was told about (`--workers`, `--worker-cpus`, `--label`),
 * and the summary. See benchmarks/README.md, "Load testing", for setting up
 * the deployment under test.
 */

import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

import { capabilityDeclaration } from "@/lib/ai/providers/config"

import { box, palette } from "../corpus/lib/tui"
import { gitCommit } from "../lib/corpus"
import { LoadDashboard, summaryBoxes } from "./dashboard"
import {
  isLoadFormat,
  LOAD_FORMATS,
  loadFixtures,
  type LoadFormat,
} from "./fixtures"
import { Observer } from "./observe"
import {
  burst,
  readHeavy,
  RunState,
  scaleIn,
  SCENARIOS,
  steady,
  summarise,
  type Scenario,
  type ScenarioOptions,
} from "./scenarios"
import { startStubProvider, STUB_MODEL } from "./stub-provider"

const HERE = import.meta.dirname
const RESULTS = path.join(HERE, "..", "results")

const USAGE = `Usage: pnpm load <scenario> [url] [options]

Scenarios: ${SCENARIOS.join(", ")}, or "stub" to run only the stub provider,
or "fixtures" to build the upload files and exit.
The URL defaults to $ANONIFY_URL, then http://127.0.0.1:3000.

Load
  --reviewers <n>        virtual reviewers, each with its own session (default 4; burst 20)
  --duration <s>         steady, read-heavy, scale-in: how long (default 300)
  --warmup <s>           steady, scale-in: not counted in throughput (default 60)
  --think <ms>           pause between a reviewer's actions (default 2000; read-heavy 1000)
  --formats <a,b>        ${LOAD_FORMATS.join(", ")} (default all)
  --batch <n>            files per batch (default: one of each format)
  --documents <n>        burst: how many (default 200)
  --window <s>           burst: arriving within (default 60)
  --ready-timeout <s>    a document not ready by then is lost (default 900)
  --no-export            stop at accepting; skip the export and download
  --keep                 leave documents in place instead of deleting them
  --sse-sample <0-1>     share of documents whose progress stream is followed (default 0.25)

Scale-in
  --term-cmd <shell>     stops one worker gracefully (default with --docker: docker stop)
  --kill-cmd <shell>     kills one worker (default with --docker: docker kill)
  --term-at <0-1>        when, as a share of --duration (default 0.33)
  --kill-at <0-1>        (default 0.66)
  --recovery-timeout <s> how long to wait for recovered runs (default 900)

Stub provider
  --stub                 run the stub provider for the length of the run
  --stub-port <n>        (default 4010)
  --stub-latency <ms>    median answer time (default 800)
  --stub-429 <0-1>       share of calls refused with 429 (default 0.02)
  --stub-public-url <u>  the stub's base URL as the deployment reaches it
                         (default http://host.docker.internal:<port>/v1)
  --seed <n>             (default 1)

Observation
  --metrics <url>        a /api/metrics endpoint to scrape; repeatable
  --metrics-token <t>    its ANONIFY_METRICS_TOKEN
  --docker <name>        sample every container whose name contains this
  --sample <s>           how often (default 5)

The result
  --workers <n>          worker replicas under test, for per-worker throughput
  --worker-cpus <n>      vCPUs per worker, recorded with the result
  --worker-memory <s>    memory limit per worker, e.g. 4g, recorded
  --label <k=v>          anything else worth recording; repeatable
  --out <file>           where to write (default benchmarks/results/load-<scenario>-<time>.json)
  --no-save              print the summary only
`

function number(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(
      `--${name} must be a non-negative number, not ${JSON.stringify(value)}`
    )
  return parsed
}

let log = (message: string): void => {
  console.log(`[${new Date().toTimeString().slice(0, 8)}] ${message}`)
}

/** The environment the deployment under test needs to use the stub. */
function stubEnvironment(publicUrl: string): Record<string, string> {
  const env = {
    AI_PROVIDER: "openai-compatible",
    AI_BASE_URL: publicUrl,
    AI_MODEL: STUB_MODEL,
  }
  return {
    ...env,
    AI_MODEL_CAPABILITIES: capabilityDeclaration(env, {
      structuredOutput: true,
      vision: true,
    }),
  }
}

/** Finds a worker container to stop, for the scale-in defaults. */
async function dockerWorkers(filter: string): Promise<string[]> {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { stdout } = await promisify(execFile)("docker", [
    "ps",
    "--filter",
    `name=${filter}`,
    "--format",
    "{{.Names}}",
  ])
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name && /worker/.test(name))
    .sort()
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      reviewers: { type: "string" },
      duration: { type: "string" },
      warmup: { type: "string" },
      think: { type: "string" },
      formats: { type: "string" },
      batch: { type: "string" },
      documents: { type: "string" },
      window: { type: "string" },
      "ready-timeout": { type: "string" },
      "no-export": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      "sse-sample": { type: "string" },
      "term-cmd": { type: "string" },
      "kill-cmd": { type: "string" },
      "term-at": { type: "string" },
      "kill-at": { type: "string" },
      "recovery-timeout": { type: "string" },
      stub: { type: "boolean", default: false },
      "stub-port": { type: "string" },
      "stub-latency": { type: "string" },
      "stub-429": { type: "string" },
      "stub-public-url": { type: "string" },
      seed: { type: "string" },
      metrics: { type: "string", multiple: true, default: [] },
      "metrics-token": { type: "string" },
      docker: { type: "string" },
      sample: { type: "string" },
      workers: { type: "string" },
      "worker-cpus": { type: "string" },
      "worker-memory": { type: "string" },
      label: { type: "string", multiple: true, default: [] },
      out: { type: "string" },
      "no-save": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  const [command, url] = positionals
  if (values.help || !command) {
    process.stdout.write(USAGE)
    return
  }

  const stubPort = number("stub-port", values["stub-port"], 4010)
  const stubOptions = {
    port: stubPort,
    latencyMs: number("stub-latency", values["stub-latency"], 800),
    rateLimitShare: number("stub-429", values["stub-429"], 0.02),
    seed: number("seed", values.seed, 1),
  }
  const stubPublicUrl =
    values["stub-public-url"] ?? `http://host.docker.internal:${stubPort}/v1`

  if (command === "stub") {
    const stub = await startStubProvider(stubOptions)
    log(
      `stub provider on ${stub.url} (${stubOptions.latencyMs}ms median, ${stubOptions.rateLimitShare * 100}% 429)`
    )
    console.log("\nSet on the deployment under test:\n")
    for (const [key, value] of Object.entries(stubEnvironment(stubPublicUrl)))
      console.log(`${key}=${value}`)
    console.log("\nCtrl-C to stop.")
    setInterval(
      () =>
        log(`${stub.counters.calls} call(s), ${stub.counters.refused} refused`),
      30_000
    )
    return
  }

  const formats = (values.formats
    ?.split(",")
    .map((format) => format.trim()) ?? [...LOAD_FORMATS]) as string[]
  for (const format of formats)
    if (!isLoadFormat(format))
      throw new Error(
        `--formats: ${format} is not one of ${LOAD_FORMATS.join(", ")}`
      )

  if (command === "fixtures") {
    const fixtures = await loadFixtures(formats as LoadFormat[], 4, log)
    log(`${fixtures.length} fixture(s) ready in benchmarks/load/.cache/`)
    return
  }

  if (!(SCENARIOS as readonly string[]).includes(command))
    throw new Error(`unknown scenario ${JSON.stringify(command)}; try --help`)
  const scenario = command as Scenario

  const base = (
    url ??
    process.env.ANONIFY_URL ??
    "http://127.0.0.1:3000"
  ).replace(/\/$/, "")
  const workers = values.workers ? number("workers", values.workers, 0) : null

  let termCommand = values["term-cmd"]
  let killCommand = values["kill-cmd"]
  if (
    scenario === "scale-in" &&
    values.docker &&
    (!termCommand || !killCommand)
  ) {
    const found = await dockerWorkers(values.docker)
    if (found.length < 3)
      log(
        `scale-in: ${found.length} worker container(s) found; with fewer than 3 the ` +
          "last one standing is all that is left. Try --scale worker=3."
      )
    // Compose's grace period, so the stop is the one an orchestrator sends.
    termCommand ??= found[0] ? `docker stop --time 130 ${found[0]}` : undefined
    killCommand ??= found[1]
      ? `docker kill --signal KILL ${found[1]}`
      : undefined
  }

  const options: ScenarioOptions = {
    base,
    reviewers: number(
      "reviewers",
      values.reviewers,
      scenario === "burst" ? 20 : 4
    ),
    durationMs: number("duration", values.duration, 300) * 1000,
    warmupMs: number("warmup", values.warmup, 60) * 1000,
    thinkMs: number(
      "think",
      values.think,
      scenario === "read-heavy" ? 1000 : 2000
    ),
    readyTimeoutMs:
      number("ready-timeout", values["ready-timeout"], 900) * 1000,
    batchSize: number("batch", values.batch, formats.length),
    documents: number("documents", values.documents, 200),
    windowMs: number("window", values.window, 60) * 1000,
    export: !values["no-export"],
    keep: values.keep,
    sseSample: number("sse-sample", values["sse-sample"], 0.25),
    termCommand,
    killCommand,
    termAt: number("term-at", values["term-at"], 0.33),
    killAt: number("kill-at", values["kill-at"], 0.66),
    recoveryTimeoutMs:
      number("recovery-timeout", values["recovery-timeout"], 900) * 1000,
    log,
  }
  if (
    options.warmupMs >= options.durationMs &&
    scenario !== "burst" &&
    scenario !== "read-heavy"
  )
    throw new Error("--warmup must be shorter than --duration")

  const workerCpus = values["worker-cpus"]
    ? number("worker-cpus", values["worker-cpus"], 0)
    : null
  const topology = [
    workers !== null ? `${workers} worker${workers === 1 ? "" : "s"}` : null,
    workerCpus !== null ? `${workerCpus} vCPU` : null,
    values["worker-memory"] ?? null,
  ]
    .filter(Boolean)
    .join(" × ")
  const c = palette()
  console.log(
    `\n${box(
      [
        `${c.dim("target")}     ${base}`,
        `${c.dim("load")}       ${
          scenario === "burst"
            ? `${options.documents} documents within ${options.windowMs / 1000}s, ${options.reviewers} reviewers`
            : `${options.reviewers} reviewers for ${options.durationMs / 1000}s` +
              (scenario === "read-heavy"
                ? ""
                : `, batches of ${options.batchSize}, ${options.warmupMs / 1000}s warm-up`)
        }`,
        `${c.dim("formats")}    ${formats.join(", ")}`,
        ...(topology ? [`${c.dim("topology")}   ${topology}`] : []),
        `${c.dim("provider")}   ${
          values.stub
            ? `stub, ${stubOptions.latencyMs}ms median, ${Math.round(stubOptions.rateLimitShare * 100)}% 429`
            : "whatever the target is configured with"
        }`,
        ...(scenario === "scale-in"
          ? [
              `${c.dim("SIGTERM")}    ${options.termCommand ?? c.yellow("none given")}`,
              `${c.dim("SIGKILL")}    ${options.killCommand ?? c.yellow("none given")}`,
            ]
          : []),
      ],
      c,
      `pnpm load ${scenario}`
    )}`
  )
  const dashboard = new LoadDashboard({
    title: `${scenario} · ${base}${topology ? ` · ${topology}` : ""}`,
    workerCpus,
  })
  log = (message) => dashboard.log(message)
  // The terminal back as it was. What was started keeps running on the
  // server, and nothing is written: a partial window is not a result.
  process.once("SIGINT", () => {
    dashboard.stop()
    console.error(
      "\nstopped; documents already handed over finish on the server"
    )
    process.exit(130)
  })
  options.log = log
  options.onReviewers = (list) => {
    dashboard.reviewers = list
  }

  // The target first: a load test against a stack that is not ready measures
  // nothing but its error page.
  const ready = await fetch(`${base}/api/ready`).catch(() => null)
  if (!ready?.ok)
    throw new Error(
      `${base}/api/ready did not answer 200; is the deployment up?`
    )
  const limits = (await (await fetch(`${base}/api/limits`)).json()) as {
    profile: string
    rateLimits: { name: string; limit: number; windowSeconds: number }[]
  }
  const upload = limits.rateLimits.find((limit) => limit.name === "upload")
  log(`target ${base} (profile ${limits.profile})`)
  // One machine is one network address, and rate limits are per address.
  if (upload && upload.limit < 1000)
    log(
      `warning: the target allows ${upload.limit} uploads per ${upload.windowSeconds}s per ` +
        "address, and every reviewer here shares one. Raise ANONIFY_RATE_LIMIT_* on the " +
        "target (docker-compose.load.yml does), or 429s will be what this measures."
    )

  const stub = values.stub ? await startStubProvider(stubOptions) : null
  if (stub)
    log(`stub provider on ${stub.url}; the target must use ${stubPublicUrl}`)
  dashboard.stub = stub?.counters ?? null

  dashboard.setNote(
    "making the upload files from the corpus (cached after the first run)"
  )
  dashboard.start()
  const perFormat = Math.max(
    2,
    Math.ceil(options.batchSize / formats.length) * 2
  )
  const fixtures = await loadFixtures(formats as LoadFormat[], perFormat, log)
  dashboard.setNote("")

  const observer = new Observer({
    metricsUrls: values.metrics,
    metricsToken: values["metrics-token"],
    docker: values.docker,
    intervalMs: number("sample", values.sample, 5) * 1000,
  })
  observer.start()
  dashboard.observe = () => observer.live()

  const state = new RunState()
  dashboard.state = state
  const startedAt = new Date()
  const runner = {
    steady,
    burst,
    "read-heavy": readHeavy,
    "scale-in": scaleIn,
  }[scenario]
  try {
    await runner(fixtures, options, state)
  } finally {
    dashboard.stop()
    await stub?.close()
  }
  const observation = await observer.stop()
  const summary = summarise(state, workers)

  const result = {
    kind: "anonify-load",
    version: 1,
    scenario,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    target: base,
    commit: gitCommit(),
    harness: {
      host: os.hostname(),
      cpus: os.availableParallelism(),
      node: process.version,
    },
    topology: {
      workers,
      workerCpus,
      workerMemory: values["worker-memory"] ?? null,
      labels: Object.fromEntries(
        values.label.map((label) => {
          const index = label.indexOf("=")
          return index > 0
            ? [label.slice(0, index), label.slice(index + 1)]
            : [label, ""]
        })
      ),
    },
    options: {
      ...Object.fromEntries(
        Object.entries(options).filter(
          ([key]) => key !== "log" && key !== "base"
        )
      ),
      formats,
    },
    stub: stub ? { ...stubOptions, ...stub.counters } : null,
    summary,
    observation,
  }

  console.log(`\n${summaryBoxes(result, c)}`)
  if (!values["no-save"]) {
    const out =
      values.out ??
      path.join(
        RESULTS,
        `load-${scenario}-${startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`
      )
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`)
    log(`wrote ${path.relative(process.cwd(), out)}`)
  }

  // The one assertion a load run makes on its own: nothing it handed over
  // disappeared. scale-in exists for this; every scenario holds to it.
  if (summary.documents.lost > 0) {
    console.error(
      `\nFAILED: ${summary.documents.lost} document(s) never finished`
    )
    process.exitCode = 1
  }
  if (scenario === "scale-in" && summary.documents.failed > 0) {
    console.error(
      `\nFAILED: ${summary.documents.failed} document(s) failed during scale-in`
    )
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
