import { readFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { palette } from "@/benchmarks/corpus/lib/tui"
import { sparkline } from "@/benchmarks/load/dashboard"
import { parseMetrics } from "@/benchmarks/load/observe"
import { RunState, summarise } from "@/benchmarks/load/scenarios"
import {
  minimalInstance,
  startStubProvider,
  STUB_MODEL,
} from "@/benchmarks/load/stub-provider"
import { capabilityDeclaration } from "@/lib/ai/providers/config"
import {
  classificationSchema,
  columnAnalysisSchema,
  detectionResultSchema,
  imageAnalysisSchema,
  verificationSchema,
} from "@/lib/ai/schemas/detection"

describe("the stub provider's answers (#190)", () => {
  // Each call the pipeline makes is a schema; an answer that does not
  // validate would be counted as a degraded analysis rather than a call, and
  // the load test would measure the failure path instead of the real one.
  it.each([
    ["detections", detectionResultSchema],
    ["classification", classificationSchema],
    ["columns", columnAnalysisSchema],
    ["image", imageAnalysisSchema],
    ["verification", verificationSchema],
  ] as const)("validates against the %s schema", (_name, schema) => {
    const json = z.toJSONSchema(schema as z.ZodType) as Parameters<
      typeof minimalInstance
    >[0]
    expect(schema.safeParse(minimalInstance(json)).success).toBe(true)
  })

  it("finds nothing: arrays come back empty", () => {
    const json = z.toJSONSchema(detectionResultSchema) as Parameters<
      typeof minimalInstance
    >[0]
    expect(minimalInstance(json)).toEqual({ detections: [] })
  })

  it("respects minimums, enums and references", () => {
    expect(
      minimalInstance({
        type: "object",
        required: ["a", "b", "c", "d"],
        properties: {
          a: { type: "string", minLength: 3 },
          b: { type: "array", minItems: 2, items: { type: "boolean" } },
          c: { enum: ["low", "high"] },
          d: { $ref: "#/$defs/n" },
        },
        $defs: { n: { type: "number", minimum: 5 } },
      })
    ).toEqual({ a: "xxx", b: [false, false], c: "low", d: 5 })
  })
})

describe("the stub provider's server", () => {
  let stub: Awaited<ReturnType<typeof startStubProvider>>

  beforeAll(async () => {
    stub = await startStubProvider({
      port: 0,
      latencyMs: 1,
      rateLimitShare: 0,
      seed: 1,
    })
  })
  afterAll(() => stub.close())

  it("lists its model", async () => {
    const body = (await (await fetch(`${stub.url}/models`)).json()) as {
      data: { id: string }[]
    }
    expect(body.data.map((model) => model.id)).toEqual([STUB_MODEL])
  })

  it("answers a structured call with the minimal object and counts it", async () => {
    const response = await fetch(`${stub.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: STUB_MODEL,
        messages: [{ role: "user", content: "a page of text" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "out",
            schema: z.toJSONSchema(detectionResultSchema),
          },
        },
      }),
    })
    const body = (await response.json()) as {
      choices: { message: { content: string } }[]
      usage: { prompt_tokens: number }
    }
    expect(JSON.parse(body.choices[0].message.content)).toEqual({
      detections: [],
    })
    expect(body.usage.prompt_tokens).toBeGreaterThan(0)
    expect(stub.counters.calls).toBe(1)
  })

  it("refuses with 429 and a retry-after at a share of 1", async () => {
    const refusing = await startStubProvider({
      port: 0,
      latencyMs: 1,
      rateLimitShare: 1,
      seed: 1,
    })
    try {
      const response = await fetch(`${refusing.url}/chat/completions`, {
        method: "POST",
        body: "{}",
      })
      expect(response.status).toBe(429)
      expect(response.headers.get("retry-after")).toBe("1")
      expect(refusing.counters.refused).toBe(1)
    } finally {
      await refusing.close()
    }
  })
})

describe("reading a scrape", () => {
  it("sums the watched metrics across labels and ignores the rest", () => {
    const values = parseMetrics(
      [
        "# HELP anonify_queue_jobs_ready Ready jobs.",
        'anonify_queue_jobs_ready{queue="a"} 3',
        'anonify_queue_jobs_ready{queue="b"} 4',
        "anonify_queue_oldest_ready_seconds 12.5",
        "process_resident_memory_bytes 1.5e+08",
        "anonify_something_else 99",
      ].join("\n")
    )
    expect(Object.fromEntries(values)).toEqual({
      anonify_queue_jobs_ready: 7,
      anonify_queue_oldest_ready_seconds: 12.5,
      process_resident_memory_bytes: 150_000_000,
    })
  })
})

describe("a run's summary", () => {
  it("counts throughput inside the window only, per format and per worker", () => {
    const state = new RunState()
    const t0 = 1_000_000
    state.measuredFrom = t0
    state.measuredTo = t0 + 60_000
    state.started = 4
    state.settled.push(
      // Before the window: a warm-up document, not counted in throughput.
      {
        id: "a",
        format: "pdf",
        status: "ready",
        pages: 2,
        startedAt: t0 - 9000,
        settledAt: t0 - 1000,
      },
      {
        id: "b",
        format: "pdf",
        status: "ready",
        pages: 3,
        startedAt: t0,
        settledAt: t0 + 10_000,
      },
      {
        id: "c",
        format: "scan",
        status: "ready",
        pages: 5,
        startedAt: t0,
        settledAt: t0 + 30_000,
      },
      {
        id: "d",
        format: "scan",
        status: "failed",
        pages: 0,
        startedAt: t0,
        settledAt: t0 + 5000,
        error: "boom",
      }
    )
    const summary = summarise(state, 2)
    expect(summary.throughput.documentsPerMinute).toBe(2)
    expect(summary.throughput.pagesPerMinute).toBe(8)
    expect(summary.throughput.perWorker).toEqual({
      documentsPerMinute: 1,
      pagesPerMinute: 4,
    })
    expect(summary.byFormat.scan.failed).toBe(1)
    expect(summary.byFormat.scan.timeToReadyMs.p50).toBe(30_000)
    expect(summary.documents.failures).toEqual({ boom: 1 })
    expect(summary.documents.lost).toBe(0)
  })

  it("reports progress through the time, then through the documents", () => {
    const state = new RunState()
    state.timed("measuring", 1000)
    expect(state.progress()).toBeLessThan(0.5)
    expect(state.remainingMs()).toBeGreaterThan(0)
    state.started = 2
    state.counted("finishing", 2)
    state.settled.push({
      id: "a",
      format: "pdf",
      status: "ready",
      pages: 1,
      startedAt: 0,
      settledAt: 1,
    })
    expect(state.progress()).toBe(0.5)
    expect(state.remainingMs()).toBeNull()
  })
})

describe("the live view", () => {
  it("draws a sparkline scaled to its own maximum", () => {
    const c = palette({ isTTY: false } as NodeJS.WriteStream)
    expect(sparkline([0, 1, 2, 4, 8], c)).toBe("▁▂▃▅█")
    expect(sparkline([0, 0], c)).toBe("▁▁")
  })
})

describe("docker-compose.load.yml", () => {
  // The overlay states the stub's capability declaration by hand, because
  // Compose cannot compute it. If it stops matching, the app treats the model
  // as unverified and skips every call, and the run measures no AI at all.
  it("declares the stub's capabilities as the app would", () => {
    const file = readFileSync("docker-compose.load.yml", "utf8")
    const declared = /LOAD_AI_MODEL_CAPABILITIES:-(\{.*\})\}$/m.exec(file)?.[1]
    const url = /LOAD_STUB_URL:-([^}]+)\}/.exec(file)?.[1]
    expect(url).toBe("http://host.docker.internal:4010/v1")
    expect(declared).toBe(
      capabilityDeclaration(
        {
          AI_PROVIDER: "openai-compatible",
          AI_BASE_URL: url,
          AI_MODEL: STUB_MODEL,
        },
        { structuredOutput: true, vision: true }
      )
    )
  })
})
