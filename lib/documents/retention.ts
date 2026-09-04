import { ALLOWED_TTL_SECONDS, MAX_RETENTION_SECONDS } from "@/lib/config"

/**
 * Retention windows.
 *
 * Extending is deliberately not a renewal. The new expiry is always computed
 * from when the document was *created*, so repeatedly extending converges on
 * the 72-hour ceiling instead of walking it forward forever — which is what
 * "temporary by default" has to mean for it to mean anything.
 */

export type RetentionDecision =
  | { ok: true; expiresAt: Date; ttlSeconds: number; capped: boolean }
  | { ok: false; reason: RetentionRefusal }

export type RetentionRefusal =
  | "unsupported-window"
  | "already-at-limit"
  | "not-an-extension"
  | "would-expire-immediately"

export const RETENTION_MESSAGES: Record<RetentionRefusal, string> = {
  "unsupported-window": "That is not one of the available retention windows.",
  "already-at-limit": `This document is already at the ${
    MAX_RETENTION_SECONDS / 3600
  }-hour demo limit.`,
  "not-an-extension": "That window would not extend this document.",
  "would-expire-immediately":
    "That window has already elapsed for this document.",
}

export function resolveExtension(input: {
  createdAt: Date
  currentExpiresAt: Date
  requestedTtlSeconds: number
  now?: Date
}): RetentionDecision {
  const now = input.now ?? new Date()

  if (!(ALLOWED_TTL_SECONDS as number[]).includes(input.requestedTtlSeconds)) {
    return { ok: false, reason: "unsupported-window" }
  }

  // The ceiling is measured from creation, so an old document has less room
  // left than a new one asking for the same window.
  const ttlSeconds = Math.min(input.requestedTtlSeconds, MAX_RETENTION_SECONDS)
  const expiresAt = new Date(input.createdAt.getTime() + ttlSeconds * 1000)
  const ceiling = new Date(
    input.createdAt.getTime() + MAX_RETENTION_SECONDS * 1000
  )

  if (input.currentExpiresAt.getTime() >= ceiling.getTime()) {
    return { ok: false, reason: "already-at-limit" }
  }
  if (expiresAt.getTime() <= input.currentExpiresAt.getTime()) {
    return { ok: false, reason: "not-an-extension" }
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "would-expire-immediately" }
  }

  return {
    ok: true,
    expiresAt,
    ttlSeconds,
    capped: ttlSeconds < input.requestedTtlSeconds,
  }
}

/** How much life a document has left before it hits the ceiling. */
export function retentionCeiling(createdAt: Date): Date {
  return new Date(createdAt.getTime() + MAX_RETENTION_SECONDS * 1000)
}
