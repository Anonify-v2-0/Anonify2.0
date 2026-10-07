import type { BucketConfig } from "@/lib/security/token-bucket"

/**
 * Where pacing state lives when more than one process shares it (#184).
 *
 * `lib/services/throttle.ts` paces calls to metered providers, and its state
 * is per process. With one container that is the whole deployment. With an
 * autoscaler it is not: four workers each holding four calls in flight send
 * sixteen at an account that allows four, and nobody can set a per-replica
 * share of a limit when the replica count changes minute to minute.
 *
 * `ANONIFY_SERVICE_LIMIT_SCOPE=cluster` moves the budget into a store every
 * replica reaches, so `ANONIFY_AI_CONCURRENCY` and the rest mean the whole
 * deployment. The store is Postgres by default, which every deployment
 * already has, or Redis/Valkey (`ANONIFY_RATE_STORE=redis`) for very high
 * request rates or a deployment that already runs one.
 *
 * Two primitives, the same two the process-local gate has:
 *
 *   take     the token bucket of lib/security/token-bucket.ts, shared. One
 *            token per request; a refusal says how long to wait.
 *   lease    a slot in a concurrency limit, held while a request is in flight
 *            and renewed while it lasts. It expires on its own, so a worker
 *            that crashes mid-request gives its slots back within a TTL.
 */

export type TakeResult = {
  allowed: boolean
  /** Whole tokens left after this request (before it, for `peek`). */
  remaining: number
  /** When a refused caller could next succeed. 0 when allowed. */
  waitMs: number
}

export type RateStoreKind = "postgres" | "redis"

export interface RateStore {
  readonly kind: RateStoreKind | "memory"
  /** Spends a token if there is one. */
  take(key: string, config: BucketConfig, now: Date): Promise<TakeResult>
  /** The same answer without spending, for a panel that reports it. */
  peek(key: string, config: BucketConfig, now: Date): Promise<TakeResult>
  /** Holds the bucket's next token back until `now + waitMs` (see deferBucket). */
  defer(
    key: string,
    config: BucketConfig,
    now: Date,
    waitMs: number
  ): Promise<void>
  /** A slot under `limit`, or null when all of them are held. */
  acquireLease(
    key: string,
    limit: number,
    ttlMs: number
  ): Promise<{ id: string } | null>
  /** False when the lease had already expired. */
  renewLease(key: string, id: string, ttlMs: number): Promise<boolean>
  releaseLease(key: string, id: string): Promise<void>
  /** Throws when the store cannot be reached, for /api/ready. */
  probe(): Promise<void>
}

// --- configuration ----------------------------------------------------------

export const SERVICE_LIMIT_SCOPES = ["process", "cluster"] as const
export type ServiceLimitScope = (typeof SERVICE_LIMIT_SCOPES)[number]

export const RATE_STORES = ["postgres", "redis"] as const

/**
 * `ANONIFY_SERVICE_LIMIT_SCOPE`. `process`, the default, is exactly the
 * behaviour before #184, so a single box changes nothing. A malformed value
 * throws: a limit somebody believes is cluster-wide and is not is the failure
 * this setting exists to remove.
 */
export function serviceLimitScope(
  env: Record<string, string | undefined> = process.env
): ServiceLimitScope {
  const raw = env.ANONIFY_SERVICE_LIMIT_SCOPE?.trim().toLowerCase()
  if (!raw) return "process"
  if (!(SERVICE_LIMIT_SCOPES as readonly string[]).includes(raw))
    throw new Error(
      `ANONIFY_SERVICE_LIMIT_SCOPE must be one of: ${SERVICE_LIMIT_SCOPES.join(", ")}`
    )
  return raw as ServiceLimitScope
}

/**
 * `ANONIFY_RATE_STORE`: where the cluster scope keeps its state, and, when it
 * is `redis`, where the inbound rate limiter keeps its buckets too.
 */
export function rateStoreKind(
  env: Record<string, string | undefined> = process.env
): RateStoreKind {
  const raw = env.ANONIFY_RATE_STORE?.trim().toLowerCase()
  if (!raw) return "postgres"
  if (!(RATE_STORES as readonly string[]).includes(raw))
    throw new Error(
      `ANONIFY_RATE_STORE must be one of: ${RATE_STORES.join(", ")}`
    )
  if (raw === "redis" && !env.REDIS_URL?.trim())
    throw new Error("ANONIFY_RATE_STORE=redis needs REDIS_URL")
  return raw as RateStoreKind
}

// --- when the store cannot be reached ---------------------------------------

const WARN_INTERVAL_MS = 30_000

type FailureLog = {
  /** Since the last line logged. */
  count: number
  /** Since the process started, for throttleState and tests. */
  total: number
  lastWarnAt: number
}

const shared = globalThis as unknown as {
  anonifyRateStoreFailures?: Record<string, FailureLog>
}

/**
 * Logs a store failure and counts it, at most one line per use every 30
 * seconds, with how many fell back since the last one. A Redis outage under
 * load is thousands of failed calls a minute, and one line per call would
 * bury everything else in the log.
 *
 * What happens next is the caller's: outbound pacing carries on with the
 * process-local gate, the inbound limiter with Postgres.
 */
export function reportRateStoreFailure(
  store: RateStore["kind"],
  use: "outbound" | "inbound",
  fallback: string,
  error: unknown,
  now = Date.now()
): void {
  shared.anonifyRateStoreFailures ??= {}
  const key = `${store}:${use}`
  const log = (shared.anonifyRateStoreFailures[key] ??= {
    count: 0,
    total: 0,
    lastWarnAt: -Infinity,
  })
  log.count += 1
  log.total += 1
  if (now - log.lastWarnAt < WARN_INTERVAL_MS) return

  console.warn(
    JSON.stringify({
      level: "warn",
      context: "service.rate-store",
      store,
      use,
      fallback,
      failures: log.count,
      message: error instanceof Error ? error.message : String(error),
    })
  )
  log.lastWarnAt = now
  log.count = 0
}

/** How many times a use of the store has fallen back since the process started. */
export function rateStoreFailures(
  store: RateStore["kind"],
  use: "outbound" | "inbound"
): number {
  return shared.anonifyRateStoreFailures?.[`${store}:${use}`]?.total ?? 0
}

/** For tests. */
export function resetRateStoreFailures(): void {
  shared.anonifyRateStoreFailures = {}
}
