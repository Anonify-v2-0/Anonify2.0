import { createHash, randomBytes } from "node:crypto"
import { cookies, headers } from "next/headers"

import { requiredEnv } from "@/lib/config"

/**
 * Anonymous identity for ownership and abuse prevention.
 *
 * This exists to enforce demo quotas and document ownership — not to track
 * people. A server-issued random session id establishes ownership; a coarsened,
 * server-observed IP widens the net for quota and rate-limit buckets so that
 * clearing a cookie does not reset the demo allowance. Only salted hashes are
 * persisted. No browser fingerprinting, and no MAC addresses — a browser cannot
 * expose one, and pretending otherwise would be both insecure and unreliable.
 */

export const SESSION_COOKIE = "anonify_sid"
const SESSION_MAX_AGE = 60 * 60 * 24 * 30

/** Coarsens an address to a network so a single household shares one bucket. */
export function normalizeIp(raw: string | null | undefined): string {
  if (!raw) return "unknown"
  const ip = raw.split(",")[0].trim()
  if (!ip) return "unknown"

  if (ip.includes(":")) {
    // IPv6 → /48
    return `${ip.split(":").slice(0, 3).join(":")}::/48`
  }

  const octets = ip.split(".")
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    // IPv4 → /24
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
  }

  return "unknown"
}

function digest(...parts: string[]): string {
  const hash = createHash("sha256").update(requiredEnv("FINGERPRINT_SECRET"))
  for (const part of parts) hash.update("|").update(part)
  return hash.digest("hex")
}

/** Stable across IP changes: this is what a document belongs to. */
export function deriveOwnerKey(sessionId: string): string {
  return digest("owner", sessionId)
}

/** Session + network. Used for daily quotas. */
export function deriveQuotaKey(normalizedIp: string, sessionId: string): string {
  return digest("quota", normalizedIp, sessionId)
}

/** Network only. Used for rate limits, so a fresh cookie does not reset them. */
export function deriveNetworkKey(normalizedIp: string): string {
  return digest("network", normalizedIp)
}

export type Identity = {
  sessionId: string
  normalizedIp: string
  ownerKey: string
  quotaKey: string
  networkKey: string
}

function buildIdentity(sessionId: string, normalizedIp: string): Identity {
  return {
    sessionId,
    normalizedIp,
    ownerKey: deriveOwnerKey(sessionId),
    quotaKey: deriveQuotaKey(normalizedIp, sessionId),
    networkKey: deriveNetworkKey(normalizedIp),
  }
}

async function observedIp(): Promise<string> {
  const headerList = await headers()
  return normalizeIp(
    headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip")
  )
}

/**
 * Reads the caller's identity, issuing a session cookie when absent. Must be
 * called from a route handler or server action so the cookie can be written.
 */
export async function getIdentity(): Promise<Identity> {
  const cookieStore = await cookies()

  let sessionId = cookieStore.get(SESSION_COOKIE)?.value
  if (!sessionId || sessionId.length < 32) {
    sessionId = randomBytes(24).toString("hex")
    cookieStore.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    })
  }

  return buildIdentity(sessionId, await observedIp())
}

/** Read-only variant for contexts (pages) that must not mutate cookies. */
export async function peekIdentity(): Promise<Identity | null> {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value
  if (!sessionId) return null

  return buildIdentity(sessionId, await observedIp())
}
