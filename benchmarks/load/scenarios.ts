/**
 * The four load scenarios (#190), and what each records.
 *
 * - steady:    N reviewers, each uploading a batch, waiting for it, accepting,
 *              exporting and starting again, for a fixed time. Throughput and
 *              time-to-ready at a load the deployment should sustain.
 * - burst:     M documents arriving within W seconds. How long the queue
 *              takes to drain, and how old its oldest job got.
 * - read-heavy: reviewers with finished documents browsing and searching
 *              them. Latency on the web role, with no processing to hide
 *              behind.
 * - scale-in:  steady, with one worker stopped (SIGTERM) a third of the way
 *              in and another killed (SIGKILL) at two thirds. Every document
 *              must still finish (#182).
 */

import { exec } from "node:child_process"
import { promisify } from "node:util"

import { percentile } from "../lib/corpus"
import {
  HttpError,
  Recorder,
  Reviewer,
  type DocumentState,
  type Uploaded,
} from "./client"
import type { Fixture, LoadFormat } from "./fixtures"

const shell = promisify(exec)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const SCENARIOS = ["steady", "burst", "read-heavy", "scale-in"] as const
export type Scenario = (typeof SCENARIOS)[number]

export type ScenarioOptions = {
  base: string
  reviewers: number
  durationMs: number
  warmupMs: number
  thinkMs: number
  readyTimeoutMs: number
  /** Files per batch in steady and scale-in. */
  batchSize: number
  /** burst: documents, and the window they arrive in. */
  documents: number
  windowMs: number
  export: boolean
  keep: boolean
  /** Share of documents whose progress stream is followed for event lag. */
  sseSample: number
  /** scale-in: what to run, and when, as a share of the duration. */
  termCommand?: string
  killCommand?: string
  termAt: number
  killAt: number
  recoveryTimeoutMs: number
  log: (message: string) => void
  /** Called with the reviewers once they exist, for the live view. */
  onReviewers?: (reviewers: Reviewer[]) => void
}

type Settled = {
  id: string
  format: LoadFormat
  status: string
  pages: number
  startedAt: number
  settledAt: number
  error?: string | null
}

/** Everything a run observed, before it is summarised. */
export class RunState {
  recorder = new Recorder()
  readonly settled: Settled[] = []
  readonly lost: { id: string; format: LoadFormat }[] = []
  readonly exportMs: number[] = []
  readonly sseLagMs: number[] = []
  readonly errors = new Map<string, number>()
  readonly events: { at: number; what: string }[] = []
  degraded = 0
  refused = 0
  started = 0
  measuredFrom = 0
  measuredTo = 0
  /** For the live view: what the run is doing, and how far through it is. */
  phase = "starting"
  private span: { from: number; to: number } | null = null
  private target: number | null = null

  /** Progress is the share of `ms` elapsed from now. */
  timed(phase: string, ms: number): void {
    this.phase = phase
    this.span = { from: Date.now(), to: Date.now() + ms }
    this.target = null
  }

  /** Progress is the share of `documents` settled. */
  counted(phase: string, documents: number): void {
    this.phase = phase
    this.target = documents
  }

  progress(): number {
    if (this.target !== null)
      return this.target === 0
        ? 1
        : (this.settled.length + this.lost.length) / this.target
    if (!this.span) return 0
    return Math.min(
      1,
      (Date.now() - this.span.from) / (this.span.to - this.span.from)
    )
  }

  remainingMs(): number | null {
    if (this.target !== null || !this.span) return null
    return Math.max(0, this.span.to - Date.now())
  }

  error(error: unknown): void {
    const key =
      error instanceof HttpError
        ? `${error.route} ${error.status}`
        : error instanceof Error
          ? error.message.slice(0, 120)
          : String(error)
    this.errors.set(key, (this.errors.get(key) ?? 0) + 1)
  }

  note(what: string): void {
    this.events.push({ at: Date.now(), what })
  }
}

/** Hands out fixtures round-robin, so every batch is the same mix. */
function rotation(fixtures: Fixture[]): (count: number) => Fixture[] {
  let next = 0
  return (count) =>
    Array.from({ length: count }, () => fixtures[next++ % fixtures.length])
}

/**
 * One document's life after it is ready, as a reviewer lives it: accept
 * what was found, export, and (unless keeping) delete.
 */
async function finish(
  reviewer: Reviewer,
  documentId: string,
  state: RunState,
  options: ScenarioOptions
): Promise<void> {
  try {
    await reviewer.acceptAll(documentId)
    const usage = await reviewer.json<{ degraded: unknown }>(
      "GET /api/documents/:id/usage",
      `/api/documents/${documentId}/usage`
    )
    if (usage.degraded) state.degraded += 1
    if (options.export)
      state.exportMs.push(
        await reviewer.exportAndDownload(
          documentId,
          Date.now() + options.readyTimeoutMs
        )
      )
    if (!options.keep) await reviewer.remove(documentId)
  } catch (error) {
    state.error(error)
  }
}

/**
 * One batch, start to finish. Returns the documents that never settled
 * before `deadline`, without counting them: steady counts them as lost at
 * once, scale-in waits for recovery first.
 */
async function oneBatch(
  reviewer: Reviewer,
  fixtures: Fixture[],
  state: RunState,
  options: ScenarioOptions,
  deadline: number
): Promise<{ batchId: string; open: Uploaded[] } | null> {
  let batch: Awaited<ReturnType<Reviewer["uploadBatch"]>>
  try {
    batch = await reviewer.uploadBatch(fixtures)
  } catch (error) {
    state.error(error)
    return null
  }
  state.refused += batch.refused
  state.started += batch.uploaded.length

  const controller = new AbortController()
  const streams = batch.uploaded
    .filter(() => Math.random() < options.sseSample)
    .map((document) => reviewer.followStream(document.id, controller.signal))

  const ready: string[] = []
  const open = await reviewer.waitForBatch(
    batch.batchId,
    batch.uploaded,
    deadline,
    (document, settled: DocumentState, at) => {
      state.settled.push({
        id: document.id,
        format: document.fixture.format,
        status: settled.status,
        pages: settled.pageCount ?? 0,
        startedAt: document.startedAt,
        settledAt: at,
        error: settled.error,
      })
      if (settled.status === "ready") ready.push(document.id)
    }
  )
  controller.abort()
  for (const lags of await Promise.all(streams)) state.sseLagMs.push(...lags)

  for (const id of ready) await finish(reviewer, id, state, options)
  return { batchId: batch.batchId, open }
}

async function steadyLoop(
  reviewer: Reviewer,
  take: (count: number) => Fixture[],
  state: RunState,
  options: ScenarioOptions,
  endAt: number,
  stragglers: { reviewer: Reviewer; batchId: string; open: Uploaded[] }[]
): Promise<void> {
  // Reviewers start spread over the first think time, not all at once.
  reviewer.doing("thinking")
  await sleep(Math.random() * options.thinkMs)
  while (Date.now() < endAt) {
    const result = await oneBatch(
      reviewer,
      take(options.batchSize),
      state,
      options,
      Date.now() + options.readyTimeoutMs
    )
    if (result && result.open.length > 0)
      stragglers.push({ reviewer, ...result })
    reviewer.doing("thinking")
    await sleep(options.thinkMs)
  }
  reviewer.doing("done")
}

/**
 * Warm-up, then measuring, then the batches still open at the end. Returns a
 * function that clears the timers.
 */
function timeline(
  state: RunState,
  options: ScenarioOptions,
  endAt: number
): () => void {
  state.timed("warming up", options.warmupMs)
  const measuring = setTimeout(
    () => state.timed("measuring", endAt - Date.now()),
    options.warmupMs
  )
  const finishing = setTimeout(
    () => state.counted("finishing open batches", state.started),
    Math.max(0, endAt - Date.now())
  )
  return () => {
    clearTimeout(measuring)
    clearTimeout(finishing)
  }
}

async function reviewers(
  options: ScenarioOptions,
  state: RunState
): Promise<Reviewer[]> {
  const list = Array.from(
    { length: options.reviewers },
    (_, index) =>
      new Reviewer(`reviewer-${index + 1}`, options.base, state.recorder)
  )
  options.onReviewers?.(list)
  await Promise.all(list.map((reviewer) => reviewer.open()))
  return list
}

export async function steady(
  fixtures: Fixture[],
  options: ScenarioOptions,
  state: RunState
): Promise<void> {
  const take = rotation(fixtures)
  const team = await reviewers(options, state)
  const startedAt = Date.now()
  const endAt = startedAt + options.durationMs
  state.measuredFrom = startedAt + options.warmupMs
  state.measuredTo = endAt
  const stragglers: {
    reviewer: Reviewer
    batchId: string
    open: Uploaded[]
  }[] = []
  options.log(
    `steady: ${team.length} reviewer(s), batches of ${options.batchSize}, ` +
      `${options.durationMs / 1000}s`
  )
  const phases = timeline(state, options, endAt)
  await Promise.all(
    team.map((reviewer) =>
      steadyLoop(reviewer, take, state, options, endAt, stragglers)
    )
  )
  phases()
  for (const { open } of stragglers)
    for (const document of open)
      state.lost.push({ id: document.id, format: document.fixture.format })
}

export async function burst(
  fixtures: Fixture[],
  options: ScenarioOptions,
  state: RunState
): Promise<void> {
  const take = rotation(fixtures)
  const team = await reviewers(options, state)
  const gap = options.windowMs / options.documents
  const startedAt = Date.now()
  state.measuredFrom = startedAt
  options.log(
    `burst: ${options.documents} document(s) over ${options.windowMs / 1000}s ` +
      `from ${team.length} reviewer(s)`
  )

  // Every document is its own one-file batch, arriving on schedule.
  const arrivals = Array.from({ length: options.documents }, (_, index) => ({
    at: startedAt + index * gap,
    reviewer: team[index % team.length],
    fixture: take(1),
  }))
  const deadline = startedAt + options.windowMs + options.readyTimeoutMs
  state.counted("arriving and draining", options.documents)
  await Promise.all(
    arrivals.map(async (arrival) => {
      await sleep(Math.max(0, arrival.at - Date.now()))
      const result = await oneBatch(
        arrival.reviewer,
        arrival.fixture,
        state,
        options,
        deadline
      )
      for (const document of result?.open ?? [])
        state.lost.push({ id: document.id, format: document.fixture.format })
    })
  )
  state.measuredTo = Math.max(
    startedAt,
    ...state.settled.map((document) => document.settledAt)
  )
}

/** Light formats: the setup is not what this scenario measures. */
const BROWSABLE: LoadFormat[] = ["pdf", "docx", "xlsx"]

export async function readHeavy(
  fixtures: Fixture[],
  options: ScenarioOptions,
  state: RunState
): Promise<void> {
  const browsable = fixtures.filter((fixture) =>
    BROWSABLE.includes(fixture.format)
  )
  if (browsable.length === 0)
    throw new Error(
      `read-heavy needs one of ${BROWSABLE.join(", ")} in --formats`
    )
  const take = rotation(browsable)
  const team = await reviewers(options, state)

  options.log(
    `read-heavy: preparing a batch for each of ${team.length} reviewer(s)`
  )
  state.counted(
    "preparing documents to browse",
    team.length * Math.min(3, options.batchSize)
  )
  const owned = new Map<Reviewer, { batchId: string; ids: string[] }>()
  await Promise.all(
    team.map(async (reviewer) => {
      const batch = await reviewer.uploadBatch(
        take(Math.min(3, options.batchSize))
      )
      const ids: string[] = []
      await reviewer.waitForBatch(
        batch.batchId,
        batch.uploaded,
        Date.now() + options.readyTimeoutMs,
        (document, settled) => {
          if (settled.status === "ready") ids.push(document.id)
        }
      )
      if (ids.length > 0) owned.set(reviewer, { batchId: batch.batchId, ids })
    })
  )
  if (owned.size === 0)
    throw new Error(
      "no reviewer had a ready document to browse; is a worker running?"
    )

  // Only the browsing is measured.
  state.recorder = new Recorder()
  for (const reviewer of team) reviewer.recorder = state.recorder
  const startedAt = Date.now()
  const endAt = startedAt + options.durationMs
  state.measuredFrom = startedAt
  state.measuredTo = endAt
  options.log(`read-heavy: browsing for ${options.durationMs / 1000}s`)
  state.timed("browsing", options.durationMs)

  await Promise.all(
    [...owned].map(async ([reviewer, { batchId, ids }]) => {
      reviewer.doing("thinking")
      await sleep(Math.random() * options.thinkMs)
      let turn = 0
      while (Date.now() < endAt) {
        const id = ids[turn++ % ids.length]
        reviewer.doing(`browsing ${id.slice(-6)}`)
        try {
          await reviewer.call("GET /api/documents", "/api/documents")
          await reviewer.batch(batchId)
          const outline = await reviewer.json<{ pageNumbers?: number[] }>(
            "GET /api/documents/:id/content?view=outline",
            `/api/documents/${id}/content?view=outline`
          )
          // A workbook has no pages: its sheets come with the outline, as
          // the editor reads them.
          const pages = outline.pageNumbers ?? []
          if (pages.length > 0)
            await reviewer.call(
              "GET /api/documents/:id/content?page",
              `/api/documents/${id}/content?page=${pages[turn % pages.length]}`
            )
          await reviewer.call(
            "GET /api/documents/:id/redactions",
            `/api/documents/${id}/redactions`
          )
          await reviewer.call(
            "POST /api/documents/:id/search",
            `/api/documents/${id}/search`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                spec: {
                  kind: "literal",
                  pattern: "the",
                  matchCase: false,
                  wholeWord: true,
                },
              }),
            }
          )
        } catch (error) {
          state.error(error)
        }
        reviewer.doing("thinking")
        await sleep(options.thinkMs)
      }
      reviewer.doing("done")
    })
  )

  if (!options.keep)
    for (const [reviewer, { ids }] of owned)
      for (const id of ids) await reviewer.remove(id).catch(() => {})
}

async function disrupt(
  command: string | undefined,
  label: string,
  state: RunState,
  options: ScenarioOptions
): Promise<void> {
  if (!command) {
    options.log(`scale-in: no ${label} command; skipped`)
    state.note(`${label}: skipped (no command)`)
    return
  }
  options.log(`scale-in: ${label}: ${command}`)
  state.note(`${label}: ${command}`)
  try {
    // Not awaited to the end: a graceful stop takes as long as the drain.
    const pending = shell(command)
    pending.then(
      () => state.note(`${label}: returned`),
      (error: Error) =>
        state.note(`${label}: failed: ${error.message.slice(0, 200)}`)
    )
  } catch (error) {
    state.note(`${label}: failed: ${String(error)}`)
  }
}

export async function scaleIn(
  fixtures: Fixture[],
  options: ScenarioOptions,
  state: RunState
): Promise<void> {
  const take = rotation(fixtures)
  const team = await reviewers(options, state)
  const startedAt = Date.now()
  const endAt = startedAt + options.durationMs
  state.measuredFrom = startedAt + options.warmupMs
  state.measuredTo = endAt
  const stragglers: {
    reviewer: Reviewer
    batchId: string
    open: Uploaded[]
  }[] = []

  const term = setTimeout(
    () => void disrupt(options.termCommand, "SIGTERM", state, options),
    options.durationMs * options.termAt
  )
  const kill = setTimeout(
    () => void disrupt(options.killCommand, "SIGKILL", state, options),
    options.durationMs * options.killAt
  )
  options.log(
    `scale-in: ${team.length} reviewer(s) for ${options.durationMs / 1000}s; ` +
      `SIGTERM at ${Math.round(options.termAt * 100)}%, SIGKILL at ${Math.round(options.killAt * 100)}%`
  )
  const phases = timeline(state, options, endAt)
  await Promise.all(
    team.map((reviewer) =>
      steadyLoop(reviewer, take, state, options, endAt, stragglers)
    )
  )
  phases()
  clearTimeout(term)
  clearTimeout(kill)

  // A killed worker's run is found by the sweep once it has shown no progress
  // for ANONIFY_STUCK_RUN_MINUTES, and started again (#182). Wait for that
  // before calling anything lost.
  const waiting = stragglers.reduce((sum, entry) => sum + entry.open.length, 0)
  if (waiting > 0) {
    options.log(
      `scale-in: ${waiting} document(s) still open; waiting up to ` +
        `${options.recoveryTimeoutMs / 1000}s for recovery`
    )
    const deadline = Date.now() + options.recoveryTimeoutMs
    state.timed("waiting for recovered runs", options.recoveryTimeoutMs)
    await Promise.all(
      stragglers.map(async ({ reviewer, batchId, open }) => {
        const ready: string[] = []
        const still = await reviewer.waitForBatch(
          batchId,
          open,
          deadline,
          (document, settled, at) => {
            state.settled.push({
              id: document.id,
              format: document.fixture.format,
              status: settled.status,
              pages: settled.pageCount ?? 0,
              startedAt: document.startedAt,
              settledAt: at,
              error: settled.error,
            })
            if (settled.status === "ready") ready.push(document.id)
          },
          5000
        )
        for (const document of still)
          state.lost.push({ id: document.id, format: document.fixture.format })
        for (const id of ready) await finish(reviewer, id, state, options)
      })
    )
  }
}

// --- the summary --------------------------------------------------------------

export type Distribution = {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
}

function distribution(values: number[]): Distribution {
  return {
    count: values.length,
    p50: Math.round(percentile(values, 0.5)),
    p95: Math.round(percentile(values, 0.95)),
    p99: Math.round(percentile(values, 0.99)),
    max: Math.round(values.length ? Math.max(...values) : 0),
  }
}

export function summarise(state: RunState, workers: number | null) {
  const windowMs = Math.max(1, state.measuredTo - state.measuredFrom)
  const inWindow = state.settled.filter(
    (document) =>
      document.status === "ready" &&
      document.settledAt >= state.measuredFrom &&
      document.settledAt <= state.measuredTo
  )
  const perMinute = (count: number) =>
    Math.round((count / (windowMs / 60_000)) * 100) / 100

  const formats = [...new Set(state.settled.map((document) => document.format))]
  const byFormat = Object.fromEntries(
    formats.map((format) => {
      const ready = state.settled.filter(
        (document) => document.format === format && document.status === "ready"
      )
      const windowed = inWindow.filter((document) => document.format === format)
      return [
        format,
        {
          ready: ready.length,
          failed: state.settled.filter(
            (document) =>
              document.format === format && document.status === "failed"
          ).length,
          documentsPerMinute: perMinute(windowed.length),
          pagesPerMinute: perMinute(
            windowed.reduce((sum, document) => sum + document.pages, 0)
          ),
          timeToReadyMs: distribution(
            ready.map((document) => document.settledAt - document.startedAt)
          ),
        },
      ]
    })
  )
  const documentsPerMinute = perMinute(inWindow.length)
  const pagesPerMinute = perMinute(
    inWindow.reduce((sum, document) => sum + document.pages, 0)
  )
  const firstStart = Math.min(
    ...state.settled.map((document) => document.startedAt)
  )
  const lastSettled = Math.max(
    ...state.settled.map((document) => document.settledAt)
  )

  return {
    window: {
      from: new Date(state.measuredFrom).toISOString(),
      seconds: Math.round(windowMs / 1000),
    },
    documents: {
      started: state.started,
      ready: state.settled.filter((document) => document.status === "ready")
        .length,
      failed: state.settled.filter((document) => document.status === "failed")
        .length,
      lost: state.lost.length,
      refusedAtReservation: state.refused,
      degradedAnalyses: state.degraded,
      failures: Object.fromEntries(
        Object.entries(
          state.settled
            .filter((document) => document.status === "failed")
            .reduce<Record<string, number>>((counts, document) => {
              const key = document.error ?? "no reason given"
              counts[key] = (counts[key] ?? 0) + 1
              return counts
            }, {})
        )
      ),
    },
    throughput: {
      documentsPerMinute,
      pagesPerMinute,
      perWorker:
        workers && workers > 0
          ? {
              documentsPerMinute:
                Math.round((documentsPerMinute / workers) * 100) / 100,
              pagesPerMinute:
                Math.round((pagesPerMinute / workers) * 100) / 100,
            }
          : null,
      drainSeconds:
        state.settled.length > 0
          ? Math.round((lastSettled - firstStart) / 1000)
          : null,
    },
    byFormat,
    exportMs: distribution(state.exportMs),
    sseLagMs: distribution(state.sseLagMs),
    routes: Object.fromEntries(
      [...state.recorder.latencies]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([route, values]) => [route, distribution(values)])
    ),
    httpFailures: Object.fromEntries(state.recorder.failures),
    throttled: Object.fromEntries(state.recorder.throttled),
    errors: Object.fromEntries(state.errors),
    events: state.events.map((event) => ({
      at: new Date(event.at).toISOString(),
      what: event.what,
    })),
    lost: state.lost,
  }
}

export type Summary = ReturnType<typeof summarise>
