import { healthState } from "@/lib/health/state"

/**
 * Readiness: can this replica take traffic and jobs right now (#167)?
 *
 * Each dependency is checked in parallel, under its own timeout, and the
 * answer names what failed and nothing else. A connection string, a bucket
 * name or a driver's error message is never in the response: it is logged,
 * as structured JSON, for whoever runs the instance.
 *
 * The answer is kept for a second, so a burst of probes from an orchestrator
 * cannot turn into a burst of queries against the database.
 */

export type ReadinessCheck = () => Promise<void>

export type Readiness =
  | { status: "ready"; checks: Record<string, number> }
  | { status: "not-ready"; failed: string[] }

export const DEFAULT_READY_TIMEOUT_MS = 2000
const CACHE_MS = 1000

/** ANONIFY_READY_TIMEOUT_MS, each check's limit. A malformed value throws. */
export function readyTimeoutMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.ANONIFY_READY_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_READY_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 60_000)
    throw new Error(
      "ANONIFY_READY_TIMEOUT_MS must be a whole number of milliseconds from 1 to 60000"
    )
  return value
}

function withTimeout(check: ReadinessCheck, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    check(),
    new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Runs `checks` and reports. A draining replica is not ready, whatever its
 * dependencies say, and is not checked at all.
 */
export async function checkReadiness(
  checks: Record<string, ReadinessCheck>,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS
): Promise<Readiness> {
  if (healthState().draining)
    return { status: "not-ready", failed: ["draining"] }

  const results = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      const began = performance.now()
      try {
        await withTimeout(check, timeoutMs)
        return { name, ms: Math.round(performance.now() - began) }
      } catch (error) {
        // The detail is for the operator's logs, never for the response.
        console.error(
          JSON.stringify({
            level: "error",
            context: "health.ready",
            check: name,
            message: error instanceof Error ? error.message : String(error),
          })
        )
        return { name, ms: null }
      }
    })
  )

  const failed = results.filter((r) => r.ms === null).map((r) => r.name)
  if (failed.length > 0) return { status: "not-ready", failed }
  return {
    status: "ready",
    checks: Object.fromEntries(results.map((r) => [r.name, r.ms as number])),
  }
}

let cached: { at: number; answer: Readiness } | null = null

/** `checkReadiness`, answered from the last second's result when there is one. */
export async function cachedReadiness(
  checks: () => Record<string, ReadinessCheck>,
  timeoutMs = readyTimeoutMs(),
  now = Date.now()
): Promise<Readiness> {
  if (cached && now - cached.at < CACHE_MS && !healthState().draining)
    return cached.answer
  const answer = await checkReadiness(checks(), timeoutMs)
  cached = { at: now, answer }
  return answer
}

/** For tests. */
export function clearReadinessCache(): void {
  cached = null
}
