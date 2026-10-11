import {
  box as drawBox,
  duration,
  fit,
  pad,
  palette,
  progressBar,
  type Palette,
} from "../corpus/lib/tui"
import { compact } from "../lib/dashboard"
import type { Reviewer } from "./client"
import type { LiveView } from "./observe"
import type { RunState, Summary } from "./scenarios"

/**
 * The live view of a load run, in the style of the other benchmarks': log
 * lines scroll by, and below them a region redrawn a dozen times a second
 * holds the run's progress, what every reviewer is doing, throughput as a
 * sparkline, time-to-ready per format, the queue, and each container's CPU and
 * memory against its limit.
 *
 * Plain ANSI, no dependency. When stdout is not a terminal (CI, a pipe, a log
 * file) nothing is redrawn: events are plain lines, with a status line every
 * thirty seconds, so a run's output can still be read back afterwards.
 */

const ESC = "\x1b["
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
/** Reviewer rows shown before the rest are folded into one line. */
const MAX_ROWS = 10
/** Throughput buckets in the sparkline. */
const BUCKET_MS = 10_000
const BUCKETS = 30

type Stream = NodeJS.WriteStream

export type DashboardOptions = {
  /** "steady · http://localhost:3000 · 2 workers × 2 vCPU" */
  title: string
  /** vCPUs per worker, to scale a container's CPU bar; else its peak. */
  workerCpus: number | null
  stream?: Stream
}

/** A sparkline of `values`, scaled to their own maximum. */
export function sparkline(values: number[], c: Palette): string {
  const max = Math.max(...values, 0)
  return values
    .map((value) => {
      if (max === 0) return c.gray(BLOCKS[0])
      const index = Math.min(
        BLOCKS.length - 1,
        Math.round((value / max) * (BLOCKS.length - 1))
      )
      return value === 0 ? c.gray(BLOCKS[0]) : c.cyan(BLOCKS[index])
    })
    .join("")
}

function seconds(ms: number): string {
  return ms >= 100_000
    ? `${Math.round(ms / 1000)}s`
    : `${(ms / 1000).toFixed(1)}s`
}

function gib(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`
}

export class LoadDashboard {
  readonly c: Palette
  readonly live: boolean
  private readonly stream: Stream
  private readonly startedAt = Date.now()
  private height = 0
  private frame = 0
  private timer: NodeJS.Timeout | null = null
  private status: NodeJS.Timeout | null = null
  private note = ""

  state: RunState | null = null
  reviewers: Reviewer[] = []
  observe: (() => LiveView) | null = null
  stub: { calls: number; refused: number } | null = null

  constructor(private readonly options: DashboardOptions) {
    this.stream = options.stream ?? process.stdout
    this.c = palette(this.stream)
    this.live = Boolean(this.stream.isTTY) && !process.env.CI
  }

  start(): void {
    if (this.live) {
      if (this.timer) return
      this.stream.write(`${ESC}?25l`)
      process.once("exit", () => this.stream.write(`${ESC}?25h`))
      this.timer = setInterval(() => {
        this.frame++
        this.render()
      }, 80)
      this.timer.unref()
      this.render()
      return
    }
    // No terminal to redraw: a line now and then, so a log still shows progress.
    this.status = setInterval(() => this.log(this.statusLine()), 30_000)
    this.status.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.status) clearInterval(this.status)
    this.timer = null
    this.status = null
    if (this.live) {
      this.clear()
      this.stream.write(`${ESC}?25h`)
    }
  }

  /** A permanent line, printed above the live region. */
  log(line: string): void {
    const stamped = `${this.c.gray(new Date().toTimeString().slice(0, 8))} ${line}`
    if (!this.live) {
      this.stream.write(
        `${this.c.enabled ? stamped : stamped.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")}\n`
      )
      return
    }
    this.clear()
    this.stream.write(`${fit(stamped, (this.stream.columns ?? 100) - 1)}\n`)
    this.render()
  }

  setNote(note: string): void {
    this.note = note
    this.render()
  }

  private clear(): void {
    if (this.height > 0) this.stream.write(`${ESC}${this.height}F${ESC}0J`)
    this.height = 0
  }

  private render(): void {
    if (!this.live) return
    const lines = this.lines()
    const width = (this.stream.columns ?? 100) - 1
    const up = this.height > 0 ? `${ESC}${this.height}F` : ""
    this.stream.write(
      `${up}${lines.map((line) => `${fit(line, width)}${ESC}0K`).join("\n")}\n${ESC}0J`
    )
    this.height = lines.length
  }

  private counts() {
    const state = this.state
    if (!state) return null
    const ready = state.settled.filter((d) => d.status === "ready").length
    const failed = state.settled.filter((d) => d.status === "failed").length
    const throttled = [...state.recorder.throttled.values()].reduce(
      (a, b) => a + b,
      0
    )
    const errors =
      [...state.recorder.failures.values()].reduce((a, b) => a + b, 0) +
      [...state.errors.values()].reduce((a, b) => a + b, 0)
    return {
      ready,
      failed,
      inFlight: Math.max(
        0,
        state.started - state.settled.length - state.lost.length
      ),
      lost: state.lost.length,
      throttled,
      errors,
      degraded: state.degraded,
    }
  }

  private statusLine(): string {
    const counts = this.counts()
    const state = this.state
    if (!counts || !state) return "preparing"
    return (
      `${state.phase}: ${counts.ready} ready, ${counts.inFlight} in flight, ` +
      `${counts.failed} failed, ${counts.lost} lost, ${counts.throttled} throttled`
    )
  }

  /** Documents settled ready per bucket, newest last. */
  private throughput(): number[] {
    const buckets = Array.from({ length: BUCKETS }, () => 0)
    const now = Date.now()
    for (const document of this.state?.settled ?? []) {
      if (document.status !== "ready") continue
      const age = Math.floor((now - document.settledAt) / BUCKET_MS)
      if (age < BUCKETS) buckets[BUCKETS - 1 - age] += 1
    }
    return buckets
  }

  private lines(): string[] {
    const { c } = this
    const state = this.state
    const width = (this.stream.columns ?? 100) - 1
    const lines = ["", `  ${c.bold(this.options.title)}`]
    if (!state) {
      lines.push(
        `  ${c.cyan(SPINNER[this.frame % SPINNER.length])} ${c.dim(this.note || "preparing")}`
      )
      return lines
    }

    // Progress: through the run's time, or a burst's documents.
    const fraction = state.progress()
    const percent = `${Math.floor(fraction * 100)}%`.padStart(4)
    const barWidth = Math.max(10, Math.min(60, width - 40))
    lines.push(
      `  ${progressBar(fraction, barWidth, this.frame, c)} ${c.bold(percent)}  ${c.magenta(state.phase)}`
    )

    const counts = this.counts()!
    const stats = [
      c.green(`✓ ${counts.ready} ready`),
      c.cyan(`⧗ ${counts.inFlight} in flight`),
      counts.failed ? c.red(`✗ ${counts.failed} failed`) : c.dim("✗ 0 failed"),
      counts.lost ? c.red(c.bold(`⚠ ${counts.lost} lost`)) : c.dim("⚠ 0 lost"),
      counts.throttled
        ? c.yellow(`↻ ${counts.throttled} throttled`)
        : c.dim("↻ 0 throttled"),
      counts.errors
        ? c.yellow(`! ${counts.errors} errors`)
        : c.dim("! 0 errors"),
      counts.degraded
        ? c.yellow(`◌ ${counts.degraded} degraded`)
        : c.dim("◌ 0 degraded"),
    ]
    lines.push(`  ${stats.join(c.gray("  ·  "))}`, "")

    // What every reviewer is doing.
    const shown = this.reviewers.slice(0, MAX_ROWS)
    shown.forEach((reviewer, index) => {
      const n = c.gray(String(index + 1).padStart(2))
      const { what, since } = reviewer.activity
      const idle = what === "thinking" || what === "idle"
      const spinner = idle
        ? c.gray("·")
        : c.cyan(SPINNER[(this.frame + index * 3) % SPINNER.length])
      const clock = c.gray(duration(Date.now() - since).padStart(5))
      lines.push(
        `  ${spinner} ${n}  ${pad(c.bold(reviewer.name), 13)} ${pad(idle ? c.gray(what) : what, 30)} ${clock}`
      )
    })
    if (this.reviewers.length > MAX_ROWS) {
      const rest = this.reviewers.slice(MAX_ROWS)
      const busy = rest.filter(
        (r) => !["thinking", "idle"].includes(r.activity.what)
      ).length
      lines.push(c.gray(`      … ${rest.length} more reviewers, ${busy} busy`))
    }
    lines.push("")

    // Throughput, as a sparkline of the last five minutes, and the rate over
    // the last one: what the deployment is doing now, not since the start.
    const lastMinute = state.settled.filter(
      (d) => d.status === "ready" && Date.now() - d.settledAt <= 60_000
    )
    const window = Math.min(1, (Date.now() - this.startedAt) / 60_000)
    const rate = (count: number) =>
      window > 0.1 ? (count / window).toFixed(1) : "—"
    lines.push(
      `  ${pad(c.dim("ready / 10s"), 14)}${sparkline(this.throughput(), c)}  ` +
        `${c.bold(rate(lastMinute.length))} ${c.dim("docs/min")}  ` +
        `${c.bold(rate(lastMinute.reduce((sum, d) => sum + d.pages, 0)))} ${c.dim("pages/min")}  ` +
        c.gray("last minute")
    )

    // Time to ready, p95 so far, per format.
    const byFormat = new Map<string, number[]>()
    for (const document of state.settled) {
      if (document.status !== "ready") continue
      const list = byFormat.get(document.format) ?? []
      list.push(document.settledAt - document.startedAt)
      byFormat.set(document.format, list)
    }
    if (byFormat.size > 0) {
      const p95 = [...byFormat].map(([format, values]) => {
        const sorted = [...values].sort((a, b) => a - b)
        return [
          format,
          sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))],
          values.length,
        ] as const
      })
      const max = Math.max(...p95.map(([, value]) => value))
      p95.forEach(([format, value, count], index) => {
        lines.push(
          `  ${pad(index === 0 ? c.dim("ready p95") : "", 14)}${pad(format, 6)} ` +
            `${progressBar(value / max, 24, null, c)} ${pad(c.bold(seconds(value)), 7)} ${c.gray(`n=${count}`)}`
        )
      })
    }

    // The deployment, as its metrics and Docker describe it.
    const view = this.observe?.()
    if (view && view.queueReady.length > 0) {
      lines.push(
        `  ${pad(c.dim("queue ready"), 14)}${sparkline(view.queueReady, c)}  ` +
          `${c.bold(String(view.queueReady.at(-1) ?? 0))} ${c.dim("jobs")}` +
          (view.oldestReadySeconds !== null
            ? `  ${c.dim("oldest")} ${view.oldestReadySeconds > 30 ? c.yellow(`${Math.round(view.oldestReadySeconds)}s`) : `${Math.round(view.oldestReadySeconds)}s`}`
            : "") +
          (view.cpuSlotsWaiting !== null
            ? `  ${c.dim("cpu slots waiting")} ${view.cpuSlotsWaiting}`
            : "")
      )
    }
    if (view && view.containers.length > 0) {
      const nameWidth = Math.min(
        28,
        Math.max(...view.containers.map((x) => x.name.length))
      )
      for (const container of view.containers) {
        const cpuScale = this.options.workerCpus
          ? this.options.workerCpus * 100
          : Math.max(100, container.cpuPeak)
        const cpu = container.cpuPercent / cpuScale
        const memory = container.memoryLimitBytes
          ? container.memoryBytes / container.memoryLimitBytes
          : 0
        const colour = (fraction: number) =>
          fraction > 0.9
            ? c.red
            : fraction > 0.7
              ? c.yellow
              : (text: string) => text
        lines.push(
          `  ${pad(c.dim(fit(container.name, nameWidth)), nameWidth + 1)} ` +
            `${c.dim("cpu")} ${progressBar(cpu, 14, null, c)} ${pad(colour(cpu)(`${Math.round(container.cpuPercent)}%`), 5)} ` +
            `${c.dim("mem")} ${progressBar(memory, 14, null, c)} ${colour(memory)(`${gib(container.memoryBytes)}`)}${c.gray(` / ${gib(container.memoryLimitBytes)}`)}`
        )
      }
    }

    for (const event of state.events.slice(-2))
      lines.push(
        `  ${c.gray(new Date(event.at).toTimeString().slice(0, 8))} ${c.yellow(event.what)}`
      )

    const remaining = state.remainingMs()
    lines.push(
      "",
      `  ${c.dim("elapsed")} ${duration(Date.now() - this.startedAt)}` +
        (remaining !== null
          ? `  ${c.dim("remaining")} ~${duration(remaining)}`
          : "") +
        (this.stub
          ? `  ${c.dim("stub")} ${compact(this.stub.calls)} calls · ${this.stub.refused} refused`
          : ""),
      `  ${c.gray(this.note || "ctrl+c stops; documents in flight are left to finish on the server")}`
    )
    return lines
  }
}

// --- the summary, printed once --------------------------------------------------

type Result = {
  scenario: string
  target: string
  summary: Summary
  observation: {
    metrics: { source: string; peak: Record<string, number> }[]
    containers: {
      name: string
      cpuPercentPeak: number
      cpuPercentMean: number
      memoryPeakBytes: number
      memoryLimitBytes: number
    }[]
  }
  stub: { calls: number; refused: number } | null
}

export function summaryBoxes(result: Result, c: Palette): string {
  const { summary } = result
  const out: string[] = []
  // Printed once, often into a log: wide enough for the route table whatever
  // the terminal, or its absence, says.
  const width = Math.max(process.stdout.columns ?? 0, 132)
  const box = (lines: string[], palette: Palette, title: string) =>
    drawBox(lines, palette, title, width)
  const row = (label: string, value: string) =>
    `${pad(c.dim(label), 22)} ${value}`

  const documents = summary.documents
  out.push(
    box(
      [
        row(
          "window",
          `${summary.window.seconds}s from ${new Date(summary.window.from).toTimeString().slice(0, 8)}`
        ),
        row(
          "documents",
          `${documents.started} started  ${c.green(`${documents.ready} ready`)}  ` +
            `${documents.failed ? c.red(`${documents.failed} failed`) : "0 failed"}  ` +
            `${documents.lost ? c.red(c.bold(`${documents.lost} lost`)) : c.green("0 lost")}`
        ),
        row(
          "throughput",
          `${c.bold(String(summary.throughput.documentsPerMinute))} docs/min  ` +
            `${c.bold(String(summary.throughput.pagesPerMinute))} pages/min`
        ),
        ...(summary.throughput.perWorker
          ? [
              row(
                "  per worker",
                `${summary.throughput.perWorker.documentsPerMinute} docs/min  ` +
                  `${summary.throughput.perWorker.pagesPerMinute} pages/min`
              ),
            ]
          : []),
        ...(summary.throughput.drainSeconds !== null
          ? [row("first start → last", `${summary.throughput.drainSeconds}s`)]
          : []),
        ...(summary.exportMs.count
          ? [
              row(
                "export + download",
                `p50 ${seconds(summary.exportMs.p50)}  p95 ${seconds(summary.exportMs.p95)}`
              ),
            ]
          : []),
        ...(summary.sseLagMs.count
          ? [
              row(
                "progress event lag",
                `p50 ${summary.sseLagMs.p50}ms  p95 ${summary.sseLagMs.p95}ms`
              ),
            ]
          : []),
        row("degraded analyses", String(documents.degradedAnalyses)),
        ...(result.stub
          ? [
              row(
                "stub provider",
                `${result.stub.calls} calls, ${result.stub.refused} refused with 429`
              ),
            ]
          : []),
      ],
      c,
      `${result.scenario} · ${result.target}`
    )
  )

  const formats = Object.entries(summary.byFormat)
  if (formats.length > 0) {
    const max = Math.max(...formats.map(([, f]) => f.timeToReadyMs.p95), 1)
    out.push(
      box(
        [
          c.dim(
            `${pad("format", 7)} ${pad("p95", 24)} ${pad("", 8)} ${pad("p50", 8)} ${pad("ready", 6)} ${pad("failed", 7)} pages/min`
          ),
          ...formats.map(
            ([format, f]) =>
              `${pad(format, 7)} ${progressBar(f.timeToReadyMs.p95 / max, 24, null, c)} ` +
              `${pad(c.bold(seconds(f.timeToReadyMs.p95)), 8)} ${pad(seconds(f.timeToReadyMs.p50), 8)} ` +
              `${pad(String(f.ready), 6)} ${pad(f.failed ? c.red(String(f.failed)) : "0", 7)} ${f.pagesPerMinute || c.gray("–")}`
          ),
        ],
        c,
        "time to ready, by format"
      )
    )
  }

  const routes = Object.entries(summary.routes)
  if (routes.length > 0) {
    const max = Math.max(...routes.map(([, r]) => r.p95), 1)
    const width = Math.max(...routes.map(([route]) => route.length))
    out.push(
      box(
        routes.map(
          ([route, r]) =>
            `${pad(route, width)}  ${progressBar(r.p95 / max, 16, null, c)} ` +
            `${pad(c.bold(`${r.p95}ms`), 8)} ${c.gray(`p50 ${r.p50}ms · n=${r.count}`)}`
        ),
        c,
        "API latency, p95"
      )
    )
  }

  const problems = [
    ...Object.entries(summary.throttled).map(([key, n]) =>
      c.yellow(`429  ${key}  ×${n}`)
    ),
    ...Object.entries(summary.httpFailures).map(([key, n]) =>
      c.red(`${key}  ×${n}`)
    ),
    ...Object.entries(summary.errors).map(([key, n]) => c.red(`${key}  ×${n}`)),
    ...Object.entries(documents.failures).map(([key, n]) =>
      c.red(`failed: ${key}  ×${n}`)
    ),
    ...summary.lost
      .slice(0, 10)
      .map((d) => c.red(c.bold(`lost: ${d.id} (${d.format})`))),
  ]
  if (problems.length > 0) out.push(box(problems, c, "what went wrong"))

  const saturation: string[] = []
  for (const container of result.observation.containers) {
    const memory = container.memoryLimitBytes
      ? container.memoryPeakBytes / container.memoryLimitBytes
      : 0
    saturation.push(
      `${pad(container.name, 26)} cpu peak ${pad(`${Math.round(container.cpuPercentPeak)}%`, 6)} ` +
        `mean ${pad(`${Math.round(container.cpuPercentMean)}%`, 6)} ` +
        `mem ${progressBar(memory, 12, null, c)} ${gib(container.memoryPeakBytes)} / ${gib(container.memoryLimitBytes)}`
    )
  }
  for (const source of result.observation.metrics) {
    const peak = source.peak
    const value = (name: string, unit = "") =>
      peak[name] === undefined
        ? "–"
        : `${Math.round(peak[name] * (unit === "ms" ? 1000 : 1))}${unit}`
    saturation.push(
      `${pad(fit(source.source.replace(/^https?:\/\//, ""), 26), 26)} ` +
        `queue ready ${value("anonify_queue_jobs_ready")} · oldest ${value("anonify_queue_oldest_ready_seconds", "s")} · ` +
        `slots waiting ${value("anonify_cpu_slots_waiting")} · db waiting ${value("anonify_db_pool_waiting")} · ` +
        `loop p99 ${value("nodejs_eventloop_lag_p99_seconds", "ms")}`
    )
  }
  if (saturation.length > 0) out.push(box(saturation, c, "saturation, peaks"))

  return out.join("\n")
}
