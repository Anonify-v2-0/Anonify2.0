import type { Registry } from "@prometheus-io/client"

import { buildId, buildVersion } from "@/lib/config/build"
import { anonifyRole } from "@/lib/config/role"
import { appPoolStats, prisma } from "@/lib/database/prisma"
import { readQueueDepth, type QueueDepth } from "@/lib/metrics/queue"
import { cpuSlotState } from "@/lib/runtime/cpu-slots"
import { schedulerState } from "@/lib/runtime/scheduler"
import { onStepFinished, stepsInFlight } from "@/lib/runtime/steps"
import { observeServices } from "@/lib/services/throttle"

/**
 * The metrics (#188), in Prometheus's text format.
 *
 * Label values are only ever names from a fixed vocabulary: a step function's
 * name, a document status, a queue kind, an outcome. Never a document id, an
 * owner, a filename or a category, which tests/metrics.test.ts checks against
 * the rendered output.
 *
 * Built on first use, on `globalThis` (route handlers and instrumentation are
 * separate bundles), and only when metrics are on: the client library is
 * imported lazily.
 */

/** The slow sources (the queue, documents by status) are read this often. */
const CACHE_MS = 15_000

type Cached<T> = { at: number; value: Promise<T> }

type MetricsState = { registry: Registry }

const shared = globalThis as unknown as {
  anonifyMetrics?: Promise<MetricsState>
}

function cached<T>(read: () => Promise<T>): () => Promise<T> {
  let entry: Cached<T> | undefined
  return () => {
    if (!entry || Date.now() - entry.at > CACHE_MS) {
      const value = read()
      entry = { at: Date.now(), value }
      // A failed read is not kept: the next scrape asks again.
      value.catch(() => {
        if (entry?.value === value) entry = undefined
      })
    }
    return entry.value
  }
}

const DOCUMENT_STATUSES = [
  "uploading",
  "queued",
  "extracting",
  "normalizing",
  "analyzing",
  "ready",
  "failed",
  "expired",
] as const

async function build(): Promise<MetricsState> {
  const client = await import("@prometheus-io/client")
  const registry = new client.Registry()
  const prefix = "anonify_"

  client.collectDefaultMetrics({ register: registry })

  const queueDepth = cached<QueueDepth[]>(readQueueDepth)
  const documentsByStatus = cached(async () =>
    prisma.document.groupBy({ by: ["status"], _count: { _all: true } })
  )

  new client.Gauge({
    name: `${prefix}queue_jobs_ready`,
    help: "Jobs that could run now: unlocked, with attempts left, and due.",
    labelNames: ["queue"],
    registers: [registry],
    async collect() {
      for (const depth of await queueDepth())
        this.set({ queue: depth.queue }, depth.ready)
    },
  })
  new client.Gauge({
    name: `${prefix}queue_jobs_locked`,
    help: "Jobs a worker has claimed.",
    labelNames: ["queue"],
    registers: [registry],
    async collect() {
      for (const depth of await queueDepth())
        this.set({ queue: depth.queue }, depth.locked)
    },
  })
  new client.Gauge({
    name: `${prefix}queue_oldest_ready_seconds`,
    help: "How long the oldest ready job has waited.",
    labelNames: ["queue"],
    registers: [registry],
    async collect() {
      for (const depth of await queueDepth())
        this.set({ queue: depth.queue }, depth.oldestReadySeconds)
    },
  })

  new client.Gauge({
    name: `${prefix}documents_by_status`,
    help: "Documents in each status.",
    labelNames: ["status"],
    registers: [registry],
    async collect() {
      this.reset()
      const known = new Set<string>(DOCUMENT_STATUSES)
      for (const status of DOCUMENT_STATUSES) this.set({ status }, 0)
      for (const row of await documentsByStatus()) {
        // A status outside the vocabulary is counted, never named.
        const status = known.has(row.status) ? row.status : "other"
        this.inc({ status }, row._count._all)
      }
    },
  })

  new client.Gauge({
    name: `${prefix}steps_in_flight`,
    help: "Workflow steps this process is running.",
    labelNames: ["step"],
    registers: [registry],
    collect() {
      this.reset()
      for (const running of stepsInFlight()) this.inc({ step: running.step })
    },
  })
  const stepDuration = new client.Histogram({
    name: `${prefix}step_duration_seconds`,
    help: "How long each workflow step attempt took, by how it ended.",
    labelNames: ["step", "outcome"],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
    registers: [registry],
  })
  const stepRetries = new client.Counter({
    name: `${prefix}step_retries_total`,
    help: "Workflow step attempts after the first.",
    labelNames: ["step"],
    registers: [registry],
  })
  onStepFinished((finished) => {
    stepDuration.observe(
      { step: finished.step, outcome: finished.outcome },
      finished.durationMs / 1000
    )
    if (finished.attempt > 1) stepRetries.inc({ step: finished.step })
  })

  new client.Gauge({
    name: `${prefix}cpu_slots_in_use`,
    help: "CPU slots held (ANONIFY_CPU_CONCURRENCY).",
    registers: [registry],
    collect() {
      this.set(cpuSlotState().inUse)
    },
  })
  new client.Gauge({
    name: `${prefix}cpu_slots_waiting`,
    help: "CPU-bound work waiting for a slot.",
    registers: [registry],
    collect() {
      this.set(cpuSlotState().waiting)
    },
  })

  const serviceRequests = new client.Counter({
    name: `${prefix}service_requests_total`,
    help: "Calls to a metered provider, by how each attempt ended.",
    labelNames: ["service", "outcome"],
    registers: [registry],
  })
  const serviceWait = new client.Histogram({
    name: `${prefix}service_throttle_wait_seconds`,
    help: "How long a call waited for its turn under the AI and OCR limits.",
    labelNames: ["service"],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  })
  observeServices({
    waited: (service, ms) => serviceWait.observe({ service }, ms / 1000),
    finished: (service, outcome) => serviceRequests.inc({ service, outcome }),
  })

  for (const [name, help, read] of [
    ["db_pool_total", "Connections the app's pool has open.", "total"],
    ["db_pool_idle", "Connections the app's pool has open and idle.", "idle"],
    [
      "db_pool_waiting",
      "Queries waiting for a connection from the app's pool.",
      "waiting",
    ],
  ] as const) {
    new client.Gauge({
      name: `${prefix}${name}`,
      help,
      labelNames: ["pool"],
      registers: [registry],
      collect() {
        const stats = appPoolStats()
        if (stats) this.set({ pool: "app" }, stats[read])
      },
    })
  }

  new client.Gauge({
    name: `${prefix}scheduler_last_success_timestamp_seconds`,
    help: "When this process last finished a sweep tick, led or not (#183). 0 before the first.",
    registers: [registry],
    collect() {
      const at = schedulerState().lastSuccessAt
      this.set(at ? at / 1000 : 0)
    },
  })

  new client.Gauge({
    name: `${prefix}build_info`,
    help: "Always 1, labelled with what this process is.",
    labelNames: ["version", "build_id", "role"],
    registers: [registry],
  }).set(
    { version: buildVersion(), build_id: buildId(), role: anonifyRole() },
    1
  )

  return { registry }
}

/** Builds the registry and starts recording; safe to call more than once. */
export function installMetrics(): Promise<MetricsState> {
  shared.anonifyMetrics ??= build()
  return shared.anonifyMetrics
}

/** The scrape: the text, and its content type. */
export async function renderMetrics(): Promise<{
  body: string
  contentType: string
}> {
  const { registry } = await installMetrics()
  return { body: await registry.metrics(), contentType: registry.contentType }
}

/** For tests. */
export function resetMetrics(): void {
  shared.anonifyMetrics = undefined
}
