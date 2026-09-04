import { z } from "zod"

import { prisma } from "@/lib/database/prisma"

/**
 * Rate limits, in three layers.
 *
 *   defaults  → chosen by deployment profile
 *   env       → ANONIFY_RATE_LIMIT_<NAME>, for Docker Compose and hosting
 *   database  → written by `pnpm rate-limit set`, changeable at runtime
 *
 * The deployed demo is a shared anonymous endpoint and is deliberately strict.
 * A self-hosted install is one person's machine and has no reason to be, so it
 * gets much larger allowances. The two are separate defaults rather than one
 * compromise that suits neither.
 *
 * Every layer is optional and the later ones only override what they set, so a
 * self-hoster can raise uploads without having to restate the others.
 */

export const RATE_LIMIT_NAMES = [
  "upload",
  "processing",
  "export",
  "read",
] as const

export type RateLimitName = (typeof RATE_LIMIT_NAMES)[number]

export type RateLimit = {
  /** Requests permitted in a burst, and the allowance per window. */
  limit: number
  windowSeconds: number
}

export type RateLimits = Record<RateLimitName, RateLimit>

export const PROFILES = ["demo", "self-hosted"] as const
export type Profile = (typeof PROFILES)[number]

/** A shared anonymous demo: strict, because anyone can reach it. */
const DEMO_DEFAULTS: RateLimits = {
  upload: { limit: 10, windowSeconds: 60 },
  processing: { limit: 30, windowSeconds: 60 },
  export: { limit: 10, windowSeconds: 60 },
  read: { limit: 240, windowSeconds: 60 },
}

/** Your own machine: generous, because the only caller is you. */
const SELF_HOSTED_DEFAULTS: RateLimits = {
  upload: { limit: 120, windowSeconds: 60 },
  processing: { limit: 300, windowSeconds: 60 },
  export: { limit: 120, windowSeconds: 60 },
  read: { limit: 2000, windowSeconds: 60 },
}

export function activeProfile(): Profile {
  const raw = process.env.ANONIFY_PROFILE?.trim().toLowerCase()
  return raw === "demo" ? "demo" : "self-hosted"
}

export function defaultsFor(profile: Profile): RateLimits {
  const source = profile === "demo" ? DEMO_DEFAULTS : SELF_HOSTED_DEFAULTS
  // Copied, so a caller mutating the result cannot edit the defaults.
  return Object.fromEntries(
    Object.entries(source).map(([name, value]) => [name, { ...value }])
  ) as RateLimits
}

const limitSchema = z.object({
  limit: z.number().int().positive().max(1_000_000),
  windowSeconds: z.number().int().positive().max(86_400),
})

export const limitsSchema = z.record(z.enum(RATE_LIMIT_NAMES), limitSchema)

export type PartialLimits = Partial<Record<RateLimitName, RateLimit>>

function envName(name: RateLimitName): string {
  return `ANONIFY_RATE_LIMIT_${name.toUpperCase()}`
}

/**
 * Reads `ANONIFY_RATE_LIMIT_UPLOAD=100/60` — requests per window in seconds.
 * A malformed value is reported rather than silently ignored: a limit someone
 * believes they set and which is not in force is worse than no setting.
 */
export function envOverrides(): PartialLimits {
  const overrides: PartialLimits = {}

  for (const name of RATE_LIMIT_NAMES) {
    const raw = process.env[envName(name)]?.trim()
    if (!raw) continue

    const match = /^(\d+)\s*\/\s*(\d+)$/.exec(raw)
    if (!match) {
      throw new Error(
        `${envName(name)} must look like "100/60" (requests/seconds), got "${raw}"`
      )
    }

    overrides[name] = {
      limit: Number(match[1]),
      windowSeconds: Number(match[2]),
    }
  }

  return overrides
}

export const SETTING_KEY = "rateLimits"

export function mergeLimits(
  base: RateLimits,
  ...layers: PartialLimits[]
): RateLimits {
  const merged = defaultsFor("self-hosted")
  for (const name of RATE_LIMIT_NAMES) merged[name] = { ...base[name] }

  for (const layer of layers) {
    for (const name of RATE_LIMIT_NAMES) {
      const value = layer[name]
      if (value) merged[name] = { ...value }
    }
  }

  return merged
}

/** Where each effective value came from, for `rate-limit show`. */
export type LimitSource = "default" | "env" | "database"

export type ResolvedLimits = {
  profile: Profile
  limits: RateLimits
  sources: Record<RateLimitName, LimitSource>
}

export function resolveLimits(
  profile: Profile,
  env: PartialLimits,
  stored: PartialLimits
): ResolvedLimits {
  const limits = mergeLimits(defaultsFor(profile), env, stored)

  const sources = Object.fromEntries(
    RATE_LIMIT_NAMES.map((name) => [
      name,
      stored[name] ? "database" : env[name] ? "env" : "default",
    ])
  ) as Record<RateLimitName, LimitSource>

  return { profile, limits, sources }
}

/** Reads overrides written by the CLI. Absent or unreadable means none. */
export async function storedOverrides(): Promise<PartialLimits> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } })
    if (!row) return {}

    const parsed = limitsSchema.safeParse(row.value)
    return parsed.success ? (parsed.data as PartialLimits) : {}
  } catch {
    // The limiter must still work before migrations have been applied.
    return {}
  }
}

export async function saveOverrides(overrides: PartialLimits): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: overrides },
    update: { value: overrides },
  })
}

export async function clearOverrides(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: SETTING_KEY } })
}

/**
 * The effective limits.
 *
 * Cached briefly so a CLI change takes effect without a restart while the
 * hot path does not query settings on every request.
 */
const CACHE_MS = 10_000
let cached: { at: number; value: ResolvedLimits } | null = null

export async function effectiveLimits(): Promise<ResolvedLimits> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value

  const resolved = resolveLimits(
    activeProfile(),
    envOverrides(),
    await storedOverrides()
  )

  cached = { at: Date.now(), value: resolved }
  return resolved
}

export function clearLimitsCache(): void {
  cached = null
}
