import { activeProfile, type Profile } from "@/lib/config/profile"

/**
 * How much of a batch happens at once.
 *
 * Three numbers, and they answer three different questions that were all
 * previously answered by accident:
 *
 *   maxFiles      how many documents one batch may hold. This existed, as a
 *                 constant nobody could change without a rebuild.
 *   processing    how many of one owner's documents may be *processing* at
 *                 once. This did not exist at all: every upload started its
 *                 own durable run the moment its bytes landed, so twenty files
 *                 meant twenty concurrent extractions, OCR passes and model
 *                 calls. The rate limiter bounded how fast runs could be
 *                 *started*, which is not the same thing and never was.
 *   exporting     how many documents a batch export works on at once. This was
 *                 one, and the reason was a bug rather than a policy — see
 *                 lib/workflows/export-batch.ts.
 *
 * Two layers, matching how rate limits and quotas already work: a default
 * chosen by deployment profile, and an environment override for anyone whose
 * machine disagrees. A shared demo rations a single endpoint against everyone;
 * a self-hosted install is one person's laptop and has nobody to ration
 * against, so they get separate defaults rather than one compromise that suits
 * neither.
 *
 * These are concurrency, not rate. A rate limit says how often work may
 * *start*; these say how much may be *in flight*, which is what actually
 * bounds memory, database connections and spend on a model provider. A system
 * with one and not the other is bounded only by how long the work happens to
 * take.
 */

export const BATCH_LIMIT_KEYS = ["maxFiles", "processing", "exporting"] as const

export type BatchLimitKey = (typeof BATCH_LIMIT_KEYS)[number]

export type BatchLimits = Record<BatchLimitKey, number>

/**
 * A shared anonymous demo.
 *
 * `processing: 3` is the number that matters. Extraction holds a document in
 * memory, OCR holds a rasterised page, and analysis is a paid model call —
 * three of those at once from one visitor is a shape the host can absorb while
 * still feeling immediate. Twenty was not a decision anyone made.
 *
 * `exporting: 2` is lower than processing on purpose: an export re-rasterises
 * every redacted page of a PDF, which is the heaviest thing this codebase
 * does, and it happens after the reviewer has already waited once.
 */
const DEMO_DEFAULTS: BatchLimits = {
  maxFiles: 20,
  processing: 3,
  exporting: 2,
}

/** Your own machine: the only caller is you, and the cost is your own. */
const SELF_HOSTED_DEFAULTS: BatchLimits = {
  maxFiles: 50,
  processing: 6,
  exporting: 4,
}

/** Guard rails on what an override may say, whoever is setting it. */
const BOUNDS: Record<BatchLimitKey, { min: number; max: number }> = {
  maxFiles: { min: 1, max: 500 },
  // Unbounded concurrency is the thing this file exists to remove, so there is
  // no way to ask for it back.
  processing: { min: 1, max: 64 },
  exporting: { min: 1, max: 64 },
}

export function batchDefaultsFor(profile: Profile): BatchLimits {
  return { ...(profile === "demo" ? DEMO_DEFAULTS : SELF_HOSTED_DEFAULTS) }
}

/** `ANONIFY_BATCH_MAX_FILES`, `ANONIFY_BATCH_PROCESSING`, … */
export function batchEnvName(key: BatchLimitKey): string {
  const suffix = key === "maxFiles" ? "MAX_FILES" : key.toUpperCase()
  return `ANONIFY_BATCH_${suffix}`
}

export class InvalidBatchLimitError extends Error {
  constructor(key: BatchLimitKey, raw: string) {
    const { min, max } = BOUNDS[key]
    super(
      `${batchEnvName(key)} must be a whole number between ${min} and ${max}, got "${raw}"`
    )
    this.name = "InvalidBatchLimitError"
  }
}

/**
 * The values in force.
 *
 * A malformed override throws rather than being ignored. A limit somebody
 * believes they set and which is not in force is worse than no setting at all
 * — the same rule the rate-limit reader follows, and for the same reason.
 */
export function batchLimits(profile: Profile = activeProfile()): BatchLimits {
  const limits = batchDefaultsFor(profile)

  for (const key of BATCH_LIMIT_KEYS) {
    const raw = process.env[batchEnvName(key)]?.trim()
    if (!raw) continue

    const value = Number(raw)
    const { min, max } = BOUNDS[key]
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new InvalidBatchLimitError(key, raw)
    }
    limits[key] = value
  }

  return limits
}

/** How many documents one batch may hold, and how many an upload may offer. */
export function maxBatchFiles(): number {
  return batchLimits().maxFiles
}

/** How many of one owner's documents may be processing at once. */
export function processingConcurrency(): number {
  return batchLimits().processing
}

/** How many documents a batch export works on at once. */
export function exportConcurrency(): number {
  return batchLimits().exporting
}
