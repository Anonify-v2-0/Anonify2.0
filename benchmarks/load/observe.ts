/**
 * What the deployment looked like while it was loaded (#190): its own
 * metrics (#188), and, for containers on this machine, Docker's account of
 * their CPU and memory.
 *
 * Two sources, either or both:
 *
 * - `--metrics <url>`: a `/api/metrics` endpoint scraped over HTTP. Behind a
 *   load balancer each scrape reaches whichever replica answers, which is
 *   fine for the queue (it is read from the database) and not for one
 *   replica's CPU slots. Give each replica's address if they are reachable.
 * - `--docker <name>`: every running container whose name contains it.
 *   `docker stats` gives CPU and memory against the limit, and the metrics are
 *   read from inside each container over loopback, so a worker with no
 *   published port is still measured.
 *
 * Only peaks and last values are kept. The point is "where did it saturate",
 * and a time series per container would be the bulk of every result file.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/** The metrics a capacity answer is made of; the rest of a scrape is ignored. */
const WATCHED = [
  "anonify_queue_jobs_ready",
  "anonify_queue_jobs_locked",
  "anonify_queue_oldest_ready_seconds",
  "anonify_steps_in_flight",
  "anonify_cpu_slots_in_use",
  "anonify_cpu_slots_waiting",
  "anonify_step_retries_total",
  "anonify_db_pool_total",
  "anonify_db_pool_waiting",
  "process_resident_memory_bytes",
  "nodejs_eventloop_lag_p99_seconds",
]

/** Prometheus text format, summed across label sets per watched name. */
export function parseMetrics(text: string): Map<string, number> {
  const values = new Map<string, number>()
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line)
    if (!match) continue
    const [, name, , raw] = match
    if (!WATCHED.includes(name)) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    values.set(name, (values.get(name) ?? 0) + value)
  }
  return values
}

export type SourceSummary = {
  source: string
  samples: number
  peak: Record<string, number>
  last: Record<string, number>
}

export type ContainerSummary = {
  name: string
  samples: number
  cpuPercentPeak: number
  cpuPercentMean: number
  memoryPeakBytes: number
  memoryLimitBytes: number
}

/** The latest of everything, for the live view. */
export type LiveView = {
  /** Ready jobs at each sample, the most recent last. */
  queueReady: number[]
  oldestReadySeconds: number | null
  cpuSlotsWaiting: number | null
  containers: {
    name: string
    cpuPercent: number
    cpuPeak: number
    memoryBytes: number
    memoryLimitBytes: number
  }[]
}

export type Observation = {
  metrics: SourceSummary[]
  containers: ContainerSummary[]
}

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
}

function bytes(value: string): number {
  const match = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(value.trim())
  if (!match) return 0
  return Number(match[1]) * (UNITS[match[2].toUpperCase()] ?? 1)
}

function fold(summary: SourceSummary, values: Map<string, number>): void {
  summary.samples += 1
  for (const [name, value] of values) {
    summary.last[name] = value
    summary.peak[name] = Math.max(summary.peak[name] ?? -Infinity, value)
  }
}

export class Observer {
  private readonly sources = new Map<string, SourceSummary>()
  private readonly containers = new Map<
    string,
    ContainerSummary & { cpuTotal: number }
  >()
  private timers: NodeJS.Timeout[] = []
  private readonly latest = new Map<string, LiveView["containers"][number]>()
  private readonly queueReady: number[] = []

  constructor(
    private readonly options: {
      metricsUrls: string[]
      metricsToken?: string
      docker?: string
      intervalMs: number
    }
  ) {}

  private source(name: string): SourceSummary {
    let summary = this.sources.get(name)
    if (!summary) {
      summary = { source: name, samples: 0, peak: {}, last: {} }
      this.sources.set(name, summary)
    }
    return summary
  }

  private async scrapeUrls(): Promise<void> {
    await Promise.all(
      this.options.metricsUrls.map(async (url) => {
        try {
          const response = await fetch(url, {
            headers: this.options.metricsToken
              ? { authorization: `Bearer ${this.options.metricsToken}` }
              : {},
            signal: AbortSignal.timeout(5000),
          })
          if (response.ok)
            fold(this.source(url), parseMetrics(await response.text()))
        } catch {
          /* a missed scrape is a gap, not a failure of the run */
        }
      })
    )
  }

  private async containerNames(): Promise<string[]> {
    const { stdout } = await run("docker", [
      "ps",
      "--filter",
      `name=${this.options.docker}`,
      "--format",
      "{{.Names}}",
    ])
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  }

  private async sampleDocker(): Promise<void> {
    let names: string[]
    try {
      names = await this.containerNames()
    } catch {
      return
    }
    if (names.length === 0) return
    try {
      const { stdout } = await run("docker", [
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        ...names,
      ])
      for (const line of stdout.split("\n").filter(Boolean)) {
        const stat = JSON.parse(line) as {
          Name: string
          CPUPerc: string
          MemUsage: string
        }
        const [used, limit] = stat.MemUsage.split("/")
        const cpu = Number.parseFloat(stat.CPUPerc) || 0
        const entry = this.containers.get(stat.Name) ?? {
          name: stat.Name,
          samples: 0,
          cpuPercentPeak: 0,
          cpuPercentMean: 0,
          cpuTotal: 0,
          memoryPeakBytes: 0,
          memoryLimitBytes: 0,
        }
        entry.samples += 1
        entry.cpuTotal += cpu
        entry.cpuPercentMean = entry.cpuTotal / entry.samples
        entry.cpuPercentPeak = Math.max(entry.cpuPercentPeak, cpu)
        entry.memoryPeakBytes = Math.max(entry.memoryPeakBytes, bytes(used))
        // A stopped container reports no limit; keep the one it ran with.
        entry.memoryLimitBytes = Math.max(entry.memoryLimitBytes, bytes(limit))
        this.containers.set(stat.Name, entry)
        this.latest.set(stat.Name, {
          name: stat.Name,
          cpuPercent: cpu,
          cpuPeak: entry.cpuPercentPeak,
          memoryBytes: bytes(used),
          memoryLimitBytes: entry.memoryLimitBytes,
        })
      }
    } catch {
      /* a container stopped mid-sample, as the scale-in scenario intends */
    }
    // The metrics from inside, over loopback: the scrape a private peer makes.
    await Promise.all(
      names.map(async (name) => {
        try {
          const { stdout } = await run(
            "docker",
            [
              "exec",
              name,
              "node",
              "-e",
              "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/metrics').then(r=>r.ok?r.text():'').then(t=>process.stdout.write(t))",
            ],
            { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }
          )
          if (stdout) fold(this.source(`docker:${name}`), parseMetrics(stdout))
        } catch {
          /* metrics off, or the container is gone */
        }
      })
    )
  }

  /**
   * The queue as the most recent scrape saw it. Every replica reports the same
   * queue (it is read from the database), so the largest answer is taken
   * rather than a sum.
   */
  private latestMetric(name: string): number | null {
    const values = [...this.sources.values()]
      .map((source) => source.last[name])
      .filter((value): value is number => value !== undefined)
    return values.length ? Math.max(...values) : null
  }

  live(): LiveView {
    return {
      queueReady: this.queueReady,
      oldestReadySeconds: this.latestMetric(
        "anonify_queue_oldest_ready_seconds"
      ),
      cpuSlotsWaiting: this.latestMetric("anonify_cpu_slots_waiting"),
      containers: [...this.latest.values()].sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    }
  }

  start(): void {
    const tick = () => {
      const ready = this.latestMetric("anonify_queue_jobs_ready")
      if (ready !== null) {
        this.queueReady.push(ready)
        if (this.queueReady.length > 30) this.queueReady.shift()
      }
      void this.scrapeUrls()
      if (this.options.docker) void this.sampleDocker()
    }
    tick()
    this.timers.push(setInterval(tick, this.options.intervalMs))
  }

  async stop(): Promise<Observation> {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    await this.scrapeUrls()
    return {
      metrics: [...this.sources.values()],
      containers: [...this.containers.values()].map((entry) => ({
        name: entry.name,
        samples: entry.samples,
        cpuPercentPeak: entry.cpuPercentPeak,
        cpuPercentMean: entry.cpuPercentMean,
        memoryPeakBytes: entry.memoryPeakBytes,
        memoryLimitBytes: entry.memoryLimitBytes,
      })),
    }
  }
}
