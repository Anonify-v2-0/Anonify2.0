import { createHash, timingSafeEqual } from "node:crypto"

/**
 * SHA-256 is used here for integrity only. It is not, and must never be treated
 * as, encryption — see lib/storage/encryption.ts for the real thing.
 */
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex")
}

export function checksumMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "hex")
  const b = Buffer.from(actual, "hex")
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}
