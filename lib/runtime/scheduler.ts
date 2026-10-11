/**
 * The built-in scheduler (#183).
 *
 * The sweep (lib/workflows/sweep.ts) keeps three promises: expired documents
 * are deleted, runs a dead worker left behind are restarted, and documents
 * stuck in the queue are admitted. Something outside Anonify used to have to
 * call it: Vercel's cron, Compose's opt-in `scheduler` sidecar, or a platform
 * scheduler with a shared secret. When that piece was forgotten, documents
 * were never deleted, and the only symptom was a 401 in a log nobody read.
 *
 * So every process that runs workers runs it too, on a timer:
 *
 * - every `ANONIFY_SCHEDULER_INTERVAL_SECONDS` (300), ±10%, so replicas
 *   started together do not all wake on the same second. The first tick comes
 *   one interval after start.
 * - one leader per tick: the sweep's advisory lock decides, so one replica or
 *   fifty, exactly one sweeps. The others skip, silently.
 * - a tick still running when the next is due is not overlapped.
 * - it stops on shutdown (#182), waiting for a running sweep, which is
 *   budgeted and stops between documents.
 *
 * `ANONIFY_SCHEDULER=off` turns it off, for deployments that would rather
 * drive the sweep from outside.
 */

type Env = Record<string, string | undefined>

export const SCHEDULER_ENV = "ANONIFY_SCHEDULER"
export const SCHEDULER_INTERVAL_ENV = "ANONIFY_SCHEDULER_INTERVAL_SECONDS"
export const DEFAULT_SCHEDULER_INTERVAL_SECONDS = 300

/** The share of an interval one sweep may spend purging. */
const BUDGET_SHARE = 0.8
/** ±10% around the interval. */
const JITTER = 0.1

export type SchedulerSettings = { enabled: boolean; intervalMs: number }

/** `ANONIFY_SCHEDULER` (on|off) and its interval (10–86400 s). Malformed throws. */
export function schedulerSettings(env: Env = process.env): SchedulerSettings {
  const raw = env[SCHEDULER_ENV]?.trim().toLowerCase()
  if (raw && raw !== "on" && raw !== "off")
    throw new Error(
      `${SCHEDULER_ENV} must be on or off, got "${env[SCHEDULER_ENV]}"`
    )

  const interval = env[SCHEDULER_INTERVAL_ENV]?.trim()
  let seconds = DEFAULT_SCHEDULER_INTERVAL_SECONDS
  if (interval) {
    seconds = Number(interval)
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86_400)
      throw new Error(
        `${SCHEDULER_INTERVAL_ENV} must be a whole number of seconds from 10 to 86400`
      )
  }
  return { enabled: raw !== "off", intervalMs: seconds * 1000 }
}

/** What one tick reports. `skipped` when another replica held the lock. */
export type TickResult = { skipped?: string }

export type SchedulerDeps = {
  intervalMs: number
  /** One sweep, given its purge budget. */
  sweep: (budgetMs: number) => Promise<TickResult>
  random?: () => number
  log?: (fields: Record<string, unknown>) => void
}

type SchedulerState = {
  lastSuccessAt?: number
  lastLeaderAt?: number
  ticks: number
}

const shared = globalThis as unknown as { anonifyScheduler?: SchedulerState }

function state(): SchedulerState {
  shared.anonifyScheduler ??= { ticks: 0 }
  return shared.anonifyScheduler
}

/**
 * When this process last finished a sweep without error, leader or not: a
 * skipped tick means another replica swept. For the metric (#188).
 */
export function schedulerState(): Readonly<SchedulerState> {
  return state()
}

const defaultLog = (fields: Record<string, unknown>) =>
  console.log(
    JSON.stringify({ level: "info", context: "scheduler", ...fields })
  )

export type Scheduler = {
  /** Runs one tick now, unless one is running. Resolves when it is done. */
  tick: () => Promise<void>
  /** No more ticks; resolves once the running one, if any, has finished. */
  stop: () => Promise<void>
}

export function startScheduler(deps: SchedulerDeps): Scheduler {
  const random = deps.random ?? Math.random
  const log = deps.log ?? defaultLog
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  let stopped = false

  const nextDelay = () =>
    Math.round(deps.intervalMs * (1 - JITTER + 2 * JITTER * random()))

  const tick = async (): Promise<void> => {
    // The previous tick is still going: this one is skipped, not queued.
    if (running || stopped) return
    const began = Date.now()
    running = (async () => {
      state().ticks += 1
      try {
        const result = await deps.sweep(deps.intervalMs * BUDGET_SHARE)
        state().lastSuccessAt = Date.now()
        if (result.skipped) return
        state().lastLeaderAt = Date.now()
        log({ leader: true, durationMs: Date.now() - began })
      } catch (error) {
        log({
          level: "error",
          leader: true,
          durationMs: Date.now() - began,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })().finally(() => {
      running = undefined
    })
    return running
  }

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick().finally(schedule)
    }, nextDelay())
    // A timer must not be what keeps a process alive.
    timer.unref?.()
  }
  schedule()

  return {
    tick,
    async stop() {
      stopped = true
      clearTimeout(timer)
      await running
    },
  }
}

/** For tests. */
export function resetSchedulerState(): void {
  shared.anonifyScheduler = undefined
}
