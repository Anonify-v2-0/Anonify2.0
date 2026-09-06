/**
 * What the services outside this process will tolerate.
 *
 * Two of the three things this app depends on belong to somebody else. Mistral
 * meters OCR requests per second and tokens per minute; the AI Gateway meters
 * *spend* — a credit balance, not a requests-per-minute number — with the model
 * provider behind it still free to return a 429 of its own. Neither ceiling is
 * ours to raise, and the only thing we control is how hard we push at it.
 *
 * The layering is the one used by every other limit here — a default, an
 * environment override, bounds, and a malformed value that throws rather than
 * being ignored, because a limit somebody believes they set and which is not in
 * force is worse than no setting at all (see lib/documents/batch-config.ts).
 *
 * One deliberate difference: these are *not* per-profile. Every other limit in
 * this codebase answers "who can reach this instance", where a shared demo and
 * a laptop genuinely want different answers. These describe someone else's
 * service, and an account's ceiling is the same whichever kind of install is
 * calling it. So there is one conservative set of defaults and no profile split.
 */

export const SERVICES = ["ai", "ocr"] as const

export type ServiceName = (typeof SERVICES)[number]

export type ServiceLimits = {
  /** Requests in flight at once, process-wide rather than per document. */
  concurrency: number
  /** Sustained outbound rate. 0 paces nothing. */
  requestsPerMinute: number
  /** Attempts per request, the first one included. */
  maxAttempts: number
}

export type ServiceLimitKey = keyof ServiceLimits

export const SERVICE_LIMIT_KEYS = [
  "concurrency",
  "requestsPerMinute",
  "maxAttempts",
] as const

/**
 * The gateway.
 *
 * `concurrency: 4` is the number `lib/ai/analyze.ts` already used, moved here
 * and given a different meaning: it was per *document*, so six documents
 * processing at once meant twenty-four concurrent calls and the real ceiling
 * was one nobody had chosen. Process-wide is what a provider actually sees.
 *
 * `requestsPerMinute: 0` — unpaced — because the gateway's own limit is spend,
 * and inventing a rate for it would slow every install down to guard against a
 * ceiling that does not exist. Anyone who knows the RPM of the provider behind
 * their gateway can set one; the spend cap below is the ceiling that is really
 * there.
 */
const AI_DEFAULTS: ServiceLimits = {
  concurrency: 4,
  requestsPerMinute: 0,
  maxAttempts: 4,
}

/**
 * Hosted OCR.
 *
 * Mistral's free tier is roughly one request a second, so 60/minute is the
 * rate that keeps a default install underneath it rather than discovering it a
 * page at a time. Concurrency is 2 because a burst of parallel requests is how
 * a per-second limit is hit even when the per-minute rate is fine.
 *
 * These apply only to a provider that is not local. Tesseract runs on this
 * machine and answers to nobody, and pacing it would be a slowdown and nothing
 * else.
 */
const OCR_DEFAULTS: ServiceLimits = {
  concurrency: 2,
  requestsPerMinute: 60,
  maxAttempts: 4,
}

const DEFAULTS: Record<ServiceName, ServiceLimits> = {
  ai: AI_DEFAULTS,
  ocr: OCR_DEFAULTS,
}

/** Guard rails on what an override may say, whoever is setting it. */
const BOUNDS: Record<ServiceLimitKey, { min: number; max: number }> = {
  // Unbounded concurrency against a metered service is the thing this file
  // exists to remove, so there is no way to ask for it back.
  concurrency: { min: 1, max: 64 },
  // 0 is "do not pace", which is a real answer rather than a missing one.
  requestsPerMinute: { min: 0, max: 100_000 },
  // 1 means "do not retry". Anything above 10 waits longer than a person will.
  maxAttempts: { min: 1, max: 10 },
}

export function serviceDefaults(service: ServiceName): ServiceLimits {
  return { ...DEFAULTS[service] }
}

/** `ANONIFY_AI_CONCURRENCY`, `ANONIFY_OCR_REQUESTS_PER_MINUTE`, … */
export function serviceEnvName(
  service: ServiceName,
  key: ServiceLimitKey
): string {
  const suffix =
    key === "requestsPerMinute"
      ? "REQUESTS_PER_MINUTE"
      : key === "maxAttempts"
        ? "MAX_ATTEMPTS"
        : "CONCURRENCY"
  return `ANONIFY_${service.toUpperCase()}_${suffix}`
}

export class InvalidServiceLimitError extends Error {
  constructor(service: ServiceName, key: ServiceLimitKey, raw: string) {
    const { min, max } = BOUNDS[key]
    super(
      `${serviceEnvName(service, key)} must be a whole number between ${min} and ${max}, got "${raw}"`
    )
    this.name = "InvalidServiceLimitError"
  }
}

export function serviceLimits(service: ServiceName): ServiceLimits {
  const limits = serviceDefaults(service)

  for (const key of SERVICE_LIMIT_KEYS) {
    const raw = process.env[serviceEnvName(service, key)]?.trim()
    if (!raw) continue

    const value = Number(raw)
    const { min, max } = BOUNDS[key]
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new InvalidServiceLimitError(service, key, raw)
    }
    limits[key] = value
  }

  return limits
}

// --- the gateway's actual limit: spend --------------------------------------

/** `0` is no cap, which is what an install with no configured prices gets. */
export const DEFAULT_DAILY_SPEND_USD = 0

export const SPEND_ENV_NAME = "ANONIFY_AI_DAILY_SPEND_USD"

/**
 * The fraction of the cap at which the gateway stops sprinting.
 *
 * Concurrency drops to 1 rather than the run being stopped: the work already
 * under way still finishes, it just stops arriving at the wall four calls at a
 * time. A cap that only does something at 100% is a cliff, and the last
 * document before it is the one that pays.
 */
export const SPEND_SLOWDOWN_FRACTION = 0.8

export class InvalidSpendCapError extends Error {
  constructor(raw: string) {
    super(
      `${SPEND_ENV_NAME} must be a non-negative number of US dollars, got "${raw}"`
    )
    this.name = "InvalidSpendCapError"
  }
}

/**
 * The configured daily ceiling in USD, or 0 for none.
 *
 * Not an integer: a cap of $2.50 a day is a perfectly ordinary thing to want,
 * and rounding somebody's budget to the nearest dollar without saying so is the
 * sort of quiet dishonesty this file is trying to avoid.
 */
export function dailySpendCapUsd(): number {
  const raw = process.env[SPEND_ENV_NAME]?.trim()
  if (!raw) return DEFAULT_DAILY_SPEND_USD

  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new InvalidSpendCapError(raw)

  return value
}
