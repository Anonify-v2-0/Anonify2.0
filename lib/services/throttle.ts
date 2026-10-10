import {
  consume,
  type BucketConfig,
  type BucketState,
} from "@/lib/security/token-bucket"
import {
  serviceLimits,
  SERVICES,
  type ServiceName,
} from "@/lib/services/limits"
import {
  rateStoreFailures,
  rateStoreKind,
  reportRateStoreFailure,
  serviceLimitScope,
  type RateStore,
  type ServiceLimitScope,
} from "@/lib/services/rate-store"
import { postgresRateStore } from "@/lib/services/rate-store-postgres"
import { redisRateStore } from "@/lib/services/rate-store-redis"

/**
 * Pacing outbound work, and surviving the moment it is refused anyway.
 *
 * `lib/security/rate-limit.ts` rations *inbound* callers: it refuses, and the
 * refusal is the answer. This does the opposite job for *outbound* requests to
 * a metered service, where refusing is not an option — the user has already
 * uploaded the document — so a request that arrives too early waits instead.
 *
 * There are two halves and they are not the same mechanism:
 *
 *   Pacing   keeps us under a limit we know about, by holding a request back
 *            until the bucket has a token for it. Nothing is lost; it is
 *            simply slower, which is the correct answer to "you are going too
 *            fast".
 *
 *   Retry    handles the limit we did not know about, or the one shared with
 *            somebody else's process. Only for failures where trying again can
 *            plausibly work: a 429, a 5xx, a timeout. A bad key and an empty
 *            balance are settled on the first attempt.
 *
 * Why this is not the step-level retry in `lib/workflows/process-document.ts`:
 * that one re-runs a whole step — the decrypt, the rasterisation, every page
 * already recognised — to survive a condition that lasted 800 milliseconds. A
 * rate limit is a per-request condition and wants a per-request answer, and
 * re-running the same burst against a limit that exists *because* of the burst
 * is the one response that reliably makes things worse.
 *
 * State is process-local by default: this paces one Node process against one
 * account, and with one container that is the whole deployment. With several
 * replicas sharing an account, `ANONIFY_SERVICE_LIMIT_SCOPE=cluster` (#184)
 * keeps the bucket and the in-flight count in a store they all reach, so the
 * configured numbers mean the deployment rather than each container. The
 * retry stays per request and per process either way; only the budget moves.
 * See "the cluster budget" below.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- classifying a provider failure -----------------------------------------

export type ServiceErrorKind =
  | "rate-limit"
  /** Out of credit or over a budget. Nothing to wait for. */
  | "budget"
  | "authorization"
  | "timeout"
  | "invalid-output"
  | "provider"

export type ServiceFailure = {
  kind: ServiceErrorKind
  retryable: boolean
  /** What the response asked us to wait, when it said. */
  retryAfterMs: number | null
}

type HeaderLike = { get?: (name: string) => string | null | undefined }

function headersOf(error: unknown): HeaderLike | null {
  if (typeof error !== "object" || error === null) return null
  const bag = error as Record<string, unknown>

  for (const candidate of [
    bag.responseHeaders,
    (bag.rawResponse as { headers?: unknown } | undefined)?.headers,
    (bag.response as { headers?: unknown } | undefined)?.headers,
  ]) {
    if (!candidate || typeof candidate !== "object") continue
    // A Headers instance, or the plain object the AI SDK hands back.
    const headers = candidate as Record<string, unknown> & HeaderLike
    if (typeof headers.get === "function") return headers
    return {
      get: (name: string) => {
        const direct = headers[name] ?? headers[name.toLowerCase()]
        return typeof direct === "string" ? direct : null
      },
    }
  }

  return null
}

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null
  const bag = error as Record<string, unknown>

  for (const candidate of [
    bag.statusCode,
    bag.status,
    (bag.response as { status?: unknown } | undefined)?.status,
  ]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate
    }
  }

  return null
}

/**
 * `Retry-After` is seconds or an HTTP date, and a provider under load sends
 * whichever it feels like. Honouring it matters more than the backoff curve
 * does: it is the only number in the exchange that comes from the side that
 * knows when the limit actually clears.
 */
export function retryAfterMs(error: unknown): number | null {
  const raw = headersOf(error)?.get?.("retry-after")
  if (!raw) return null

  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000)

  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.max(0, at - Date.now())

  return null
}

/**
 * What kind of failure this is, and whether trying again could help.
 *
 * Status first, message second. A status code is what the service said; the
 * message is what some library wrote about it, and matching on prose is a
 * fallback rather than a plan.
 */
export function classifyServiceError(error: unknown): ServiceFailure {
  const status = statusOf(error)
  const after = retryAfterMs(error)
  const message = error instanceof Error ? error.message : String(error)

  // Node fetch wraps a refused local connection in a cause. Waiting cannot
  // start a local model server; classify the code without exposing its raw
  // error message.
  let cause: unknown = error
  for (
    let depth = 0;
    depth < 8 && cause && typeof cause === "object";
    depth++
  ) {
    const current = cause as { code?: string; cause?: unknown }
    if (current.code === "ECONNREFUSED")
      return { kind: "provider", retryable: false, retryAfterMs: null }
    cause = current.cause
  }

  if (status !== null) {
    if (status === 429) {
      return { kind: "rate-limit", retryable: true, retryAfterMs: after }
    }
    // 402 is out of credit. Retrying spends money the account does not have,
    // and where the balance tops up automatically it spends money it does.
    if (status === 402) {
      return { kind: "budget", retryable: false, retryAfterMs: null }
    }
    if (status === 401 || status === 403) {
      return { kind: "authorization", retryable: false, retryAfterMs: null }
    }
    if (status === 408 || status === 409) {
      return { kind: "timeout", retryable: true, retryAfterMs: after }
    }
    if (status >= 500) {
      return { kind: "provider", retryable: true, retryAfterMs: after }
    }
    if (status >= 400) {
      // Every other 4xx is a request this code got wrong. Sending it again
      // unchanged gets the same answer, more slowly.
      return { kind: "invalid-output", retryable: false, retryAfterMs: null }
    }
  }

  if (/rate.?limit|too many requests|\b429\b/i.test(message)) {
    return { kind: "rate-limit", retryable: true, retryAfterMs: after }
  }
  if (/insufficient|quota exceeded|credit|billing|\b402\b/i.test(message)) {
    return { kind: "budget", retryable: false, retryAfterMs: null }
  }
  if (/401|403|api.?key|unauthor/i.test(message)) {
    return { kind: "authorization", retryable: false, retryAfterMs: null }
  }
  if (
    /timeout|ETIMEDOUT|ECONNRESET|socket hang up|aborted|fetch failed/i.test(
      message
    )
  ) {
    return { kind: "timeout", retryable: true, retryAfterMs: after }
  }
  if (/schema|validat|parse|JSON/i.test(message)) {
    return { kind: "invalid-output", retryable: false, retryAfterMs: null }
  }

  return { kind: "provider", retryable: true, retryAfterMs: after }
}

// --- backoff ----------------------------------------------------------------

const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

/**
 * Doubling from a second, capped, and then jittered.
 *
 * The jitter is the part that matters and the part the step-level backoff is
 * missing. Four calls refused by the same limit at the same moment and told to
 * wait the same interval arrive back together, and the second burst is exactly
 * the first one. Spreading them over the window turns a thundering herd into a
 * queue.
 */
export function backoffMs(
  attempt: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1)
  )
  // Full jitter: anywhere in [ceiling/2, ceiling], so a retry is never earlier
  // than half the intended wait and never in lockstep with another caller.
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

// --- the gate ---------------------------------------------------------------

type Gate = {
  /** Requests in flight right now. */
  active: number
  /** Resolvers for callers waiting on a slot, oldest first. */
  waiting: (() => void)[]
  bucket: BucketState | null
  /** Serializes bucket reservation so two waiters cannot take one token. */
  chain: Promise<void>
  /** A temporary ceiling below the configured one — see the spend cap. */
  ceiling: number | null
}

function freshGate(): Gate {
  return {
    active: 0,
    waiting: [],
    bucket: null,
    chain: Promise.resolve(),
    ceiling: null,
  }
}

const gates: Record<ServiceName, Gate> = Object.fromEntries(
  SERVICES.map((service) => [service, freshGate()])
) as unknown as Record<ServiceName, Gate>

function concurrencyFor(service: ServiceName): number {
  const configured = serviceLimits(service).concurrency
  const ceiling = gates[service].ceiling
  return ceiling === null ? configured : Math.min(configured, ceiling)
}

/**
 * Holds a service below a ceiling lower than its configured one, or lifts the
 * restriction with `null`.
 *
 * The spend cap uses this: approaching the day's budget drops the gateway to
 * one call at a time, so the run finishes rather than arriving at the wall four
 * abreast. It is never allowed to *raise* the configured limit.
 */
export function setConcurrencyCeiling(
  service: ServiceName,
  ceiling: number | null
): void {
  gates[service].ceiling = ceiling === null ? null : Math.max(1, ceiling)
  // Newly-raised ceiling: let whoever is queued through.
  drain(service)
}

function drain(service: ServiceName): void {
  const gate = gates[service]
  const limit = concurrencyFor(service)

  while (gate.waiting.length > 0 && gate.active < limit) {
    gate.active++
    gate.waiting.shift()?.()
  }
}

async function acquireSlot(service: ServiceName): Promise<void> {
  const gate = gates[service]

  if (gate.active < concurrencyFor(service)) {
    gate.active++
    return
  }

  // `active` is incremented by `drain` on the way out of the queue, not here,
  // so a slot cannot be double-counted between the wake-up and the resume.
  await new Promise<void>((resolve) => gate.waiting.push(resolve))
}

function releaseSlot(service: ServiceName): void {
  const gate = gates[service]
  gate.active = Math.max(0, gate.active - 1)
  drain(service)
}

/**
 * Waits until the bucket can afford this request.
 *
 * Burst is one second's worth of the configured rate rather than the whole
 * minute's. A bucket that starts with a minute of allowance lets sixty requests
 * leave at once, which satisfies the per-minute limit and blows straight
 * through the per-second one underneath it — and a per-second limit is exactly
 * what Mistral's free tier is.
 */
function paceConfig(perMinute: number): BucketConfig {
  return {
    burst: Math.max(1, Math.ceil(perMinute / 60)),
    refillPerSecond: perMinute / 60,
  }
}

async function awaitToken(service: ServiceName): Promise<void> {
  const perMinute = serviceLimits(service).requestsPerMinute
  if (perMinute <= 0) return

  const config = paceConfig(perMinute)
  const burst = config.burst
  const gate = gates[service]

  const reservation = gate.chain.then(async () => {
    gate.bucket ??= { tokens: burst, updatedAt: new Date() }

    for (;;) {
      const decision = consume(gate.bucket, config, new Date())
      gate.bucket = decision.state
      if (decision.allowed) return
      await sleep(decision.retryAfterMs)
    }
  })

  // The chain must survive a rejection, or one failure parks the service
  // forever. Nothing above can throw, but the queue outlives any single caller
  // and should not depend on that staying true.
  gate.chain = reservation.catch(() => undefined)
  await reservation
}

// --- the cluster budget (#184) ----------------------------------------------

/**
 * How long a lease lives without a renewal, and how often a request in flight
 * renews it. There is no timeout on a provider call to size the lease by (a
 * long generation is a long call), so instead it is short and kept alive: a
 * worker that dies mid-request frees its slot within thirty seconds.
 */
export const LEASE_TTL_MS = 30_000
export const LEASE_RENEW_MS = 10_000

/** Asking again for a lease: from 50 ms, doubling, to a second. */
const LEASE_POLL_MIN_MS = 50
const LEASE_POLL_MAX_MS = 1_000

/**
 * After the store fails, how long requests go straight to the process-local
 * gate before trying it again. Without it every request would first wait on
 * a store that has just been shown to be down.
 */
const STORE_RETRY_AFTER_MS = 10_000

const keys = {
  rate: (service: ServiceName) => `svc:${service}:rpm`,
  lease: (service: ServiceName) => `svc:${service}:lease`,
}

let storeOverride: RateStore | null | undefined
let storeDownUntil = 0
const stores: Partial<Record<string, RateStore>> = {}

/** The shared store, or null when the scope is the process. */
function clusterStore(): RateStore | null {
  if (storeOverride !== undefined) return storeOverride
  if (serviceLimitScope() === "process") return null
  const kind = rateStoreKind()
  stores[kind] ??= kind === "redis" ? redisRateStore() : postgresRateStore()
  return stores[kind]
}

/**
 * The store fell over: this request carries on with the process-local gate,
 * and so does every other for the next ten seconds. Documents keep
 * processing, paced per replica rather than per deployment, which is less
 * precise and much better than stopping.
 */
function storeFailed(store: RateStore, error: unknown): void {
  storeDownUntil = Date.now() + STORE_RETRY_AFTER_MS
  reportRateStoreFailure(store.kind, "outbound", "process", error)
}

function storeUp(): boolean {
  return Date.now() >= storeDownUntil
}

function pollDelay(poll: number): number {
  const ceiling = Math.min(LEASE_POLL_MAX_MS, LEASE_POLL_MIN_MS * 2 ** poll)
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
}

/**
 * The shared bucket. One caller per process asks the store at a time, behind
 * the same chain as the local bucket, so a hundred queued pages are one
 * client asking rather than a hundred.
 */
async function awaitSharedToken(
  service: ServiceName,
  store: RateStore
): Promise<void> {
  const perMinute = serviceLimits(service).requestsPerMinute
  if (perMinute <= 0) return

  const config = paceConfig(perMinute)
  const gate = gates[service]

  const reservation = gate.chain.then(async () => {
    for (;;) {
      const decision = await store.take(keys.rate(service), config, new Date())
      if (decision.allowed) return
      await sleep(Math.max(1, decision.waitMs))
    }
  })

  gate.chain = reservation.catch(() => undefined)
  await reservation
}

async function awaitLease(
  service: ServiceName,
  store: RateStore
): Promise<string> {
  for (let poll = 0; ; poll++) {
    const lease = await store.acquireLease(
      keys.lease(service),
      concurrencyFor(service),
      LEASE_TTL_MS
    )
    if (lease) return lease.id
    await sleep(pollDelay(poll))
  }
}

/**
 * Lets one request go: a token, then a slot. Returns what gives the slot
 * back.
 *
 * With the cluster scope the slot is two: the process-local one, which keeps
 * a replica's own callers in a queue rather than all asking the store, and a
 * lease, which is the deployment-wide limit. Both have the same limit, so the
 * local one never binds before the lease does.
 */
async function admit(service: ServiceName): Promise<() => void> {
  const store = clusterStore()
  const local = () => releaseSlot(service)

  if (!store || !storeUp()) {
    await awaitToken(service)
    await acquireSlot(service)
    return local
  }

  try {
    await awaitSharedToken(service, store)
  } catch (error) {
    storeFailed(store, error)
    await awaitToken(service)
  }

  await acquireSlot(service)
  if (!storeUp()) return local

  let id: string
  try {
    id = await awaitLease(service, store)
  } catch (error) {
    storeFailed(store, error)
    return local
  }

  const key = keys.lease(service)
  const heartbeat = setInterval(() => {
    store.renewLease(key, id, LEASE_TTL_MS).then(
      (renewed) => {
        if (!renewed)
          console.warn(
            JSON.stringify({
              level: "warn",
              context: "service.lease",
              service,
              message:
                "a lease expired while its request was in flight; the cluster limit can be exceeded until it finishes",
            })
          )
      },
      (error) => storeFailed(store, error)
    )
  }, LEASE_RENEW_MS)
  heartbeat.unref?.()

  return () => {
    clearInterval(heartbeat)
    releaseSlot(service)
    // Not awaited: the answer is already in hand, and a release that fails
    // costs a slot for one TTL, not a request.
    store.releaseLease(key, id).catch((error) => storeFailed(store, error))
  }
}

/**
 * A provider's `Retry-After`, told to every replica through the shared
 * bucket. Only where there is one: with no rate configured there is no bucket
 * to hold back, and the replica that was refused waits on its own, as before.
 */
async function deferShared(
  service: ServiceName,
  waitMs: number
): Promise<void> {
  const store = clusterStore()
  const perMinute = serviceLimits(service).requestsPerMinute
  if (!store || !storeUp() || perMinute <= 0) return
  try {
    await store.defer(
      keys.rate(service),
      paceConfig(perMinute),
      new Date(),
      waitMs
    )
  } catch (error) {
    storeFailed(store, error)
  }
}

export type ThrottleOptions = {
  /** Named in logs, so a retry storm says which call is storming. */
  label: string
  /** Overrides the configured attempt count — used by tests. */
  maxAttempts?: number
  onRetry?: (info: {
    attempt: number
    waitMs: number
    failure: ServiceFailure
  }) => void
}

/**
 * Runs one request against a metered service: paced going in, retried when the
 * service says to, and given up on when it says trying again is pointless.
 *
 * The last failure is rethrown unchanged. Deciding what a failed call *means*
 * is the caller's job — losing a page of OCR and losing the contextual pass are
 * different sizes of loss, and this layer is not the place that knows which.
 */
/**
 * What happens to calls, for the metrics (#188): how long each waited for
 * its turn, and how each attempt ended. Never the request or the answer.
 */
export type ServiceObserver = {
  waited: (service: ServiceName, ms: number) => void
  finished: (service: ServiceName, outcome: "ok" | ServiceErrorKind) => void
}

const observing = globalThis as unknown as {
  anonifyServiceObservers?: Set<ServiceObserver>
}

/** Subscribes to every call through the throttle; returns the unsubscribe. */
export function observeServices(observer: ServiceObserver): () => void {
  observing.anonifyServiceObservers ??= new Set()
  observing.anonifyServiceObservers.add(observer)
  return () => observing.anonifyServiceObservers?.delete(observer)
}

function observe(report: (observer: ServiceObserver) => void): void {
  for (const observer of observing.anonifyServiceObservers ?? []) {
    try {
      report(observer)
    } catch {
      // A metric must never fail a call.
    }
  }
}

export async function runThrottled<T>(
  service: ServiceName,
  options: ThrottleOptions,
  request: () => Promise<T>
): Promise<T> {
  const attempts = options.maxAttempts ?? serviceLimits(service).maxAttempts
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const queued = performance.now()
    const release = await admit(service)
    const waited = performance.now() - queued
    observe((observer) => observer.waited(service, waited))

    try {
      const result = await request()
      observe((observer) => observer.finished(service, "ok"))
      return result
    } catch (error) {
      lastError = error
      const kind = classifyServiceError(error).kind
      observe((observer) => observer.finished(service, kind))
    } finally {
      // Always, and before the wait: a slot is held for the duration of the
      // request and never across the pause between attempts, or one caller
      // sleeping off a 429 would block another that could go right now.
      release()
    }

    const failure = classifyServiceError(lastError)
    if (failure.kind === "rate-limit" && failure.retryAfterMs)
      await deferShared(service, failure.retryAfterMs)
    if (!failure.retryable || attempt === attempts) throw lastError

    // The service's own number wins when it gave one: it is the only value in
    // the exchange that comes from the side that knows when the limit clears.
    const waitMs = failure.retryAfterMs ?? backoffMs(attempt)
    options.onRetry?.({ attempt, waitMs, failure })

    console.warn(
      JSON.stringify({
        level: "warn",
        context: "service.retry",
        service,
        label: options.label,
        attempt,
        of: attempts,
        waitMs,
        errorCategory: failure.kind,
        // Never the message: a provider echoes the request back, and the
        // request is document text.
      })
    )

    await sleep(waitMs)
  }

  throw lastError
}

/** Test seam: forgets pacing state so one test's burst is not another's wait. */
export function resetThrottles(): void {
  for (const service of SERVICES) gates[service] = freshGate()
  storeOverride = undefined
  storeDownUntil = 0
}

/**
 * Test seam: the store the cluster scope uses, whatever the environment says.
 * `null` is the process scope; `undefined` goes back to the configuration.
 */
export function useRateStore(store: RateStore | null | undefined): void {
  storeOverride = store
  storeDownUntil = 0
}

/** What the gate is doing right now, for tests and for a diagnostic log line. */
export function throttleState(service: ServiceName): {
  active: number
  waiting: number
  ceiling: number | null
  scope: ServiceLimitScope
  /** How often the shared store failed and this process fell back. */
  fallbacks: number
} {
  const gate = gates[service]
  const store = clusterStore()
  return {
    active: gate.active,
    waiting: gate.waiting.length,
    ceiling: gate.ceiling,
    scope: store ? "cluster" : "process",
    fallbacks: store ? rateStoreFailures(store.kind, "outbound") : 0,
  }
}
