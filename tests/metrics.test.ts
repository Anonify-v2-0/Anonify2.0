import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { graphileSchema, queueDepthSql, queueOf } from "@/lib/metrics/queue"
import {
  isPrivateAddress,
  mayScrape,
  metricsSettings,
} from "@/lib/metrics/settings"
import {
  otlpHeaders,
  scrubAttributes,
  scrubSpan,
  tracesEndpoint,
} from "@/lib/metrics/tracing"
import { resetSteps, stepStarted } from "@/lib/runtime/steps"

/**
 * Metrics and traces (#188): who may scrape, what a scrape says, and that
 * nothing identifying a document is in either.
 */

const database = vi.hoisted(() => ({
  statuses: [
    { status: "ready", _count: { _all: 3 } },
    { status: "analyzing", _count: { _all: 1 } },
    { status: "something-new", _count: { _all: 2 } },
  ],
}))

vi.mock("@/lib/database/prisma", () => ({
  prisma: {
    document: { groupBy: async () => database.statuses },
  },
  appPoolStats: () => ({ total: 4, idle: 3, waiting: 0 }),
}))

vi.mock("@/lib/metrics/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metrics/queue")>()
  return {
    ...actual,
    readQueueDepth: async () => [
      { queue: "workflow", ready: 2, locked: 1, oldestReadySeconds: 4.5 },
      { queue: "step", ready: 7, locked: 3, oldestReadySeconds: 31 },
    ],
  }
})

describe("metrics settings", () => {
  it("are off unless turned on", () => {
    expect(metricsSettings({})).toEqual({ enabled: false })
    expect(metricsSettings({ ANONIFY_METRICS: "on" })).toEqual({
      enabled: true,
    })
  })

  it("refuse a malformed switch or a short token", () => {
    expect(() => metricsSettings({ ANONIFY_METRICS: "yes" })).toThrow(
      /ANONIFY_METRICS must be on or off/
    )
    expect(() =>
      metricsSettings({ ANONIFY_METRICS: "on", ANONIFY_METRICS_TOKEN: "short" })
    ).toThrow(/at least 16/)
  })
})

describe("who may scrape", () => {
  const open = { enabled: true }
  const token = { enabled: true, token: "0123456789abcdef0123" }

  it("knows a private network from the internet", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "::ffff:10.0.3.4",
      "172.20.0.5",
      "192.168.1.9",
      "100.64.0.1",
      "fd00::1",
    ])
      expect(isPrivateAddress(address)).toBe(true)
    for (const address of ["8.8.8.8", "172.32.0.1", "2001:db8::1", "", null])
      expect(isPrivateAddress(address)).toBe(false)
  })

  const direct = (address: string | null) => ({ address, forwarded: false })

  it("without a token, allows only a direct private peer", () => {
    expect(mayScrape(new Headers(), direct("10.1.2.3"), open)).toBe("allow")
    expect(mayScrape(new Headers(), direct("203.0.113.9"), open)).toBe(
      "forbidden"
    )
    expect(mayScrape(new Headers(), direct(null), open)).toBe("forbidden")
    // Behind an ingress every visitor arrives from the proxy's private
    // address; the forwarding header it arrived with is what gives it away.
    expect(
      mayScrape(new Headers(), { address: "10.1.2.3", forwarded: true }, open)
    ).toBe("forbidden")
  })

  it("with a token, asks for it from everyone", () => {
    expect(mayScrape(new Headers(), direct("127.0.0.1"), token)).toBe(
      "unauthorized"
    )
    expect(
      mayScrape(
        new Headers({ authorization: "Bearer 0123456789abcdef0123" }),
        { address: "203.0.113.9", forwarded: true },
        token
      )
    ).toBe("allow")
  })
})

describe("the queue", () => {
  it("names the world's two task lists", () => {
    expect(queueOf("workflow_flows")).toBe("workflow")
    expect(queueOf("workflow_steps")).toBe("step")
    expect(queueOf("custom_steps")).toBe("step")
    expect(queueOf("something")).toBe("other")
  })

  it("reads only the jobs view, in the configured schema", () => {
    const sql = queueDepthSql("graphile_worker")
    expect(sql).toContain('FROM "graphile_worker".jobs')
    expect(sql).not.toContain("_private")
    expect(graphileSchema({})).toBe("graphile_worker")
    expect(graphileSchema({ GRAPHILE_WORKER_SCHEMA: "jobs_2" })).toBe("jobs_2")
    expect(() =>
      graphileSchema({ GRAPHILE_WORKER_SCHEMA: 'x"; drop table y; --' })
    ).toThrow(/plain identifier/)
  })
})

describe("the scrape", () => {
  beforeEach(async () => {
    resetSteps()
    const { resetMetrics } = await import("@/lib/metrics/registry")
    resetMetrics()
  })

  it("renders every metric, labelled only from fixed vocabularies", async () => {
    const { installMetrics, renderMetrics } =
      await import("@/lib/metrics/registry")
    await installMetrics()
    // A step that ran and retried, recorded as the relay records it.
    stepStarted("extractAndNormalize", 2)("completed")
    const running = stepStarted("analyze", 1)

    const { body, contentType } = await renderMetrics()
    running("completed")

    expect(contentType).toContain("text/plain")
    for (const name of [
      "anonify_queue_jobs_ready",
      "anonify_queue_jobs_locked",
      "anonify_queue_oldest_ready_seconds",
      "anonify_documents_by_status",
      "anonify_steps_in_flight",
      "anonify_step_duration_seconds",
      "anonify_step_retries_total",
      "anonify_cpu_slots_in_use",
      "anonify_cpu_slots_waiting",
      "anonify_db_pool_total",
      "anonify_scheduler_last_success_timestamp_seconds",
      "anonify_build_info",
      "process_cpu_seconds_total",
      "nodejs_heap_size_used_bytes",
    ])
      expect(body).toContain(name)

    expect(body).toContain('anonify_queue_jobs_ready{queue="step"} 7')
    expect(body).toContain(
      'anonify_queue_oldest_ready_seconds{queue="step"} 31'
    )
    expect(body).toContain('anonify_documents_by_status{status="ready"} 3')
    // A status nobody listed is counted, not named.
    expect(body).toContain('anonify_documents_by_status{status="other"} 2')
    expect(body).not.toContain("something-new")
    expect(body).toContain('anonify_steps_in_flight{step="analyze"} 1')
    expect(body).toContain(
      'anonify_step_duration_seconds_count{step="extractAndNormalize",outcome="completed"} 1'
    )
    expect(body).toContain(
      'anonify_step_retries_total{step="extractAndNormalize"} 1'
    )
    expect(body).toContain('anonify_db_pool_idle{pool="app"} 3')

    // Nothing that looks like a document, batch, owner or run.
    expect(body).not.toMatch(/doc_|bat_|wrun_|test_|fp_[0-9a-f]/)
    expect(body).not.toMatch(/[0-9a-f]{32,}/)
  })

  it("counts provider calls and how long they waited", async () => {
    const { installMetrics, renderMetrics } =
      await import("@/lib/metrics/registry")
    const { runThrottled } = await import("@/lib/services/throttle")
    await installMetrics()
    await runThrottled(
      "ai",
      { label: "metrics-test", maxAttempts: 1 },
      async () => "ok"
    )
    const body = (await renderMetrics()).body
    expect(body).toContain(
      'anonify_service_requests_total{service="ai",outcome="ok"} 1'
    )
    expect(body).toContain(
      'anonify_service_throttle_wait_seconds_count{service="ai"} 1'
    )
  })
})

describe("traces", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("are off without an endpoint, and find it with or without the path", () => {
    expect(tracesEndpoint({})).toBeUndefined()
    expect(
      tracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" })
    ).toBe("http://collector:4318/v1/traces")
    expect(
      tracesEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://b:4318/traces",
      })
    ).toBe("http://b:4318/traces")
  })

  it("read the exporter's headers", () => {
    expect(
      otlpHeaders({ OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=abc%3D, team=ops" })
    ).toEqual({ "x-api-key": "abc=", team: "ops" })
  })

  it("leave without error text, stacks or query strings", () => {
    expect(
      scrubAttributes({
        "step.name": "extractAndNormalize",
        "step.attempt": 2,
        "step.error.message": "Unexpected token in 'Jane Doe, 12 High St'",
        "exception.message": "Jane Doe",
        "exception.stacktrace": "at parse (…)",
        "db.statement": "SELECT …",
        "url.full": "https://bucket.example/obj?X-Amz-Signature=secret",
        "http.url": "https://api.example/v1?key=secret",
        "url.query": "key=secret",
      })
    ).toEqual({
      "step.name": "extractAndNormalize",
      "step.attempt": 2,
      "url.full": "https://bucket.example/obj",
      "http.url": "https://api.example/v1",
    })
  })

  it("drop the message from a span's status and events", () => {
    const span = {
      name: "STEP extractAndNormalize",
      attributes: { "step.error.message": "Jane Doe", "step.name": "x" },
      events: [
        {
          name: "exception",
          attributes: { "exception.message": "Jane Doe" },
          time: [0, 0],
        },
      ],
      status: { code: 2, message: "Jane Doe" },
    }
    const clean = scrubSpan(span as never)
    expect(clean.name).toBe("STEP extractAndNormalize")
    expect(
      JSON.stringify([clean.attributes, clean.events, clean.status])
    ).not.toContain("Jane Doe")
    expect(clean.status).toEqual({ code: 2 })
  })
})
