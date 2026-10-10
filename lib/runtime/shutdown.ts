import { markClosing, markDraining } from "@/lib/health/state"
import {
  closeHttpServers,
  httpRequestsInFlight,
} from "@/lib/runtime/http-servers"
import { stepsInFlight, type RunningStep } from "@/lib/runtime/steps"

/**
 * Shutting down without losing work (#182).
 *
 * Every rolling deploy, scale-in, spot reclaim and node drain sends
 * `SIGTERM`, waits a grace period, then sends `SIGKILL`. Next.js on its own
 * closes its HTTP server at once, and every step a worker was running reaches
 * it as an HTTP request through the loopback relay, so the steps were cut off
 * with it. This takes over the signal and does things in order:
 *
 * 1. **Draining.** `/api/ready` answers 503, so load balancers stop sending
 *    traffic. `/api/health` stays 200: the process is not broken.
 * 2. **A pause** of `ANONIFY_DRAIN_READY_DELAY_MS` (5000), so they have
 *    noticed before anything stops answering.
 * 3. **Stopping work:** first the `"intake"` hooks, which stop starting new
 *    work (the scheduler, #183, finishing a sweep it is in), then the
 *    `"work"` hooks: the job runner stops taking jobs and waits for the ones
 *    it has. Their requests still reach this server, which is still
 *    listening.
 * 4. **Closing HTTP:** progress streams end themselves so their clients
 *    reconnect elsewhere, the servers stop accepting connections, and the
 *    requests already in flight are answered.
 * 5. **Releasing:** the `"release"` hooks (the OCR pool, #189), then the
 *    database connections. Exit 0.
 *
 * The whole sequence has `ANONIFY_DRAIN_SECONDS` (120) from the signal. Past
 * it, what was still running is logged (step names and how long they had run,
 * never content) and the process exits 1. A second signal exits at once.
 */

type Env = Record<string, string | undefined>

export const DRAIN_SECONDS_ENV = "ANONIFY_DRAIN_SECONDS"
export const DRAIN_READY_DELAY_ENV = "ANONIFY_DRAIN_READY_DELAY_MS"

export const DEFAULT_DRAIN_SECONDS = 120
export const DEFAULT_DRAIN_READY_DELAY_MS = 5000

export type DrainSettings = { drainMs: number; readyDelayMs: number }

function wholeNumber(
  env: Env,
  name: string,
  min: number,
  max: number,
  fallback: number
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  return value
}

/** The drain's deadline and readiness pause. A malformed value throws. */
export function drainSettings(env: Env = process.env): DrainSettings {
  return {
    drainMs:
      wholeNumber(env, DRAIN_SECONDS_ENV, 1, 3600, DEFAULT_DRAIN_SECONDS) *
      1000,
    readyDelayMs: wholeNumber(
      env,
      DRAIN_READY_DELAY_ENV,
      0,
      300_000,
      DEFAULT_DRAIN_READY_DELAY_MS
    ),
  }
}

export type ShutdownStage = "intake" | "work" | "release"

type Hook = { name: string; stage: ShutdownStage; run: () => Promise<void> }

const shared = globalThis as unknown as {
  anonifyShutdownHooks?: Hook[]
  anonifyShutdown?: { started: boolean; installed: boolean }
}

function hooks(): Hook[] {
  shared.anonifyShutdownHooks ??= []
  return shared.anonifyShutdownHooks
}

function status() {
  shared.anonifyShutdown ??= { started: false, installed: false }
  return shared.anonifyShutdown
}

/**
 * Registers something to stop on shutdown. `"intake"` hooks stop starting
 * new work; `"work"` hooks then stop taking work and finish what they have,
 * before HTTP closes; `"release"` hooks free resources after it has. Hooks in
 * a stage run together.
 */
export function onShutdown(
  name: string,
  run: () => Promise<void>,
  stage: ShutdownStage = "work"
): void {
  hooks().push({ name, stage, run })
}

/** Whether a shutdown has begun, for loops that should not start more work. */
export function shuttingDown(): boolean {
  return status().started
}

export type ShutdownLog = (fields: Record<string, unknown>) => void

const log: ShutdownLog = (fields) =>
  console.log(JSON.stringify({ level: "info", context: "shutdown", ...fields }))

export type ShutdownDeps = {
  settings: DrainSettings
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: ShutdownLog
  draining: () => void
  closing: () => void
  /** Runs one stage's hooks together. */
  stage: (stage: ShutdownStage) => Promise<void>
  /** Closes HTTP; resolves whether every request was answered in time. */
  closeHttp: (deadline: number) => Promise<boolean>
  disconnect: () => Promise<void>
  inFlight: () => { steps: RunningStep[]; requests: number }
}

class DeadlinePassed extends Error {}

/** Resolves with `work`, or rejects once `deadline` passes. */
async function within<T>(
  work: Promise<T>,
  deadline: number,
  deps: Pick<ShutdownDeps, "now">
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DeadlinePassed()),
          Math.max(0, deadline - deps.now())
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The sequence itself, with its effects passed in so it can be tested.
 * Resolves with the exit code.
 */
export async function runShutdown(
  signal: string,
  deps: ShutdownDeps
): Promise<number> {
  const began = deps.now()
  const deadline = began + deps.settings.drainMs
  const elapsed = () => deps.now() - began

  deps.draining()
  deps.log({ phase: "draining", signal, deadlineMs: deps.settings.drainMs })

  try {
    await deps.sleep(
      Math.min(deps.settings.readyDelayMs, Math.max(0, deadline - deps.now()))
    )

    deps.log({ phase: "stopping-work", elapsedMs: elapsed() })
    await within(deps.stage("intake"), deadline, deps)
    await within(deps.stage("work"), deadline, deps)

    deps.log({ phase: "closing-http", elapsedMs: elapsed() })
    deps.closing()
    if (!(await deps.closeHttp(deadline))) throw new DeadlinePassed()

    deps.log({ phase: "releasing", elapsedMs: elapsed() })
    await within(deps.stage("release"), deadline, deps)
    await within(deps.disconnect(), deadline, deps)
  } catch (error) {
    const { steps, requests } = deps.inFlight()
    deps.log({
      phase: "deadline",
      level: "error",
      elapsedMs: elapsed(),
      ...(error instanceof DeadlinePassed
        ? {}
        : { error: error instanceof Error ? error.name : "unknown" }),
      // What was still running: names and times, never content.
      steps: steps.map((step) => ({
        step: step.step,
        attempt: step.attempt,
        runningMs: deps.now() - step.startedAt,
      })),
      requests,
      message:
        error instanceof DeadlinePassed
          ? `shutdown did not finish within ${DRAIN_SECONDS_ENV}`
          : "shutdown failed",
    })
    return 1
  }

  deps.log({ phase: "done", elapsedMs: elapsed() })
  return 0
}

async function runStage(stage: ShutdownStage): Promise<void> {
  const results = await Promise.allSettled(
    hooks()
      .filter((hook) => hook.stage === stage)
      .map(async (hook) => {
        try {
          await hook.run()
        } catch (error) {
          console.error(
            JSON.stringify({
              level: "error",
              context: "shutdown",
              hook: hook.name,
              message: error instanceof Error ? error.message : String(error),
            })
          )
          throw error
        }
      })
  )
  if (results.some((result) => result.status === "rejected"))
    throw new Error(`a ${stage} hook failed`)
}

/** The termination signals this process answers. */
const SIGNALS = ["SIGTERM", "SIGINT"] as const

/**
 * The signals other libraries listen on to shut themselves down: the
 * workflow world's job runner (graphile-worker) registers its own handlers
 * for these and re-raises the signal when it is done, which would race this
 * sequence and read as a second signal.
 */
const FOREIGN_SIGNALS = [
  "SIGUSR2",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGABRT",
] as const

/**
 * Runs `start`, then takes off any termination-signal listeners it added.
 *
 * The world gives no way to pass graphile-worker's `noHandleSignals`, so its
 * runner installs its own handlers. Stopping the runner is this sequence's
 * job, through `world.close()`, so they come off once it has started.
 */
export async function withoutForeignSignalHandlers<T>(
  start: () => Promise<T>
): Promise<T> {
  const before = new Map(
    FOREIGN_SIGNALS.map((signal) => [
      signal,
      new Set(process.listeners(signal)),
    ])
  )
  try {
    return await start()
  } finally {
    for (const signal of FOREIGN_SIGNALS) {
      for (const listener of process.listeners(signal)) {
        if (!before.get(signal)!.has(listener))
          process.removeListener(signal, listener)
      }
    }
  }
}

/**
 * Takes over `SIGTERM` and `SIGINT`. Only with `NEXT_MANUAL_SIG_HANDLE=true`,
 * which the image sets: otherwise Next's own handler closes the server
 * immediately, and two handlers would race. Returns whether it installed.
 */
export function installShutdown(
  env: Env = process.env,
  exit: (code: number) => void = (code) => process.exit(code)
): boolean {
  if (env.NEXT_MANUAL_SIG_HANDLE !== "true") return false
  if (status().installed) return true
  status().installed = true

  const settings = drainSettings(env)

  const handler = (signal: NodeJS.Signals) => {
    if (status().started) {
      log({ phase: "forced", signal, message: "second signal: exiting now" })
      exit(1)
      return
    }
    status().started = true

    void runShutdown(signal, {
      settings,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log,
      draining: markDraining,
      closing: markClosing,
      stage: runStage,
      closeHttp: closeHttpServers,
      disconnect: async () => {
        const { prisma } = await import("@/lib/database/prisma")
        await prisma.$disconnect()
      },
      inFlight: () => ({
        steps: stepsInFlight(),
        requests: httpRequestsInFlight(),
      }),
    }).then(exit, () => exit(1))
  }

  for (const signal of SIGNALS) process.on(signal, handler)
  return true
}

/** For tests. */
export function resetShutdown(): void {
  shared.anonifyShutdownHooks = []
  shared.anonifyShutdown = undefined
}
