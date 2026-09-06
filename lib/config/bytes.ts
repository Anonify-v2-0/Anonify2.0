/**
 * Sizes, written the way people write sizes.
 *
 * These settings used to be bytes and nothing else, so bounding a mailbox at
 * 32 MiB meant typing `33554432` into a `.env` file and bounding a message's
 * decoded text meant `16777216`. Nobody gets that right from memory, and the
 * failure mode is not a syntax error — it is a plausible-looking number that
 * is off by a factor of a thousand, silently in force, discovered when a file
 * somebody expected to work is refused. A limit you cannot write down
 * correctly is a limit you cannot actually set.
 *
 * So every size here reads `32MB`, `512KB`, `1.5GB` or `2GiB`, and a plain
 * number still means bytes — an existing `.env` keeps working untouched, which
 * matters more than tidiness for a setting somebody may have deployed.
 *
 * **The units are powers of two**, so `1KB` is 1024 bytes and `MB` and `MiB`
 * mean the same thing. That is the convention every tool in this neighbourhood
 * uses — `ls -h`, `docker run --memory`, `ulimit` — and the alternative, being
 * pedantically correct about SI while every neighbouring tool is not, buys a
 * 2.4% difference in exchange for a surprise. It is stated rather than left to
 * be discovered.
 */

/** Powers of two, and both spellings of each, because both get typed. */
const UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
}

/** What a malformed size is told it should have been. */
export const BYTE_SIZE_HINT =
  "a size like 32MB, 512KB or 1GB — a plain number is read as bytes"

/**
 * A size in bytes, or null when the text is not one.
 *
 * Null rather than a throw so each caller can name the setting in its own
 * error message, which is the half of the sentence that actually helps: "must
 * be a size" is advice, and `ANONIFY_MBOX_MAX_TOTAL_BYTES must be a size` is a
 * thing somebody can go and fix.
 *
 * Zero is not a size. Every setting that reads one of these is a ceiling on
 * work, and a ceiling of zero refuses every document — which is never what
 * somebody typing a number into a limit meant, and is worth an error rather
 * than a silently broken instance.
 */
export function parseByteSize(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/_/g, "")
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(text)
  if (!match) return null

  const [, amount, suffix] = match
  const multiplier = suffix === "" ? 1 : UNITS[suffix]
  if (multiplier === undefined) return null

  // A bare number is bytes, and a fraction of a byte is not a thing. With a
  // unit it is ordinary — `1.5GB` — and the rounding is sub-byte.
  if (suffix === "" && !/^\d+$/.test(amount)) return null

  const bytes = Math.round(Number(amount) * multiplier)
  return bytes > 0 ? bytes : null
}

const SUFFIXES = [
  ["GB", 1024 ** 3],
  ["MB", 1024 ** 2],
  ["KB", 1024],
] as const

/**
 * A size as somebody would write it.
 *
 * Used where a default is *shown* — the setup script's prompts, the lines it
 * writes into `.env` — so what is printed is something that can be typed back
 * in. A whole number of units wins over a rounded one, so 32 MiB reads `32MB`
 * rather than `32.0MB`, and something that divides evenly into nothing reads
 * as its bytes rather than as a lie with a decimal point on it.
 */
export function formatByteSize(bytes: number): string {
  for (const [suffix, size] of SUFFIXES) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size}${suffix}`
  }
  for (const [suffix, size] of SUFFIXES) {
    if (bytes >= size) return `${(bytes / size).toFixed(1)}${suffix}`
  }
  return `${bytes}B`
}

/**
 * Reads one size setting out of the environment.
 *
 * The shape every limits module needs: absent means keep the default, present
 * and malformed means throw with the setting named. A malformed override is
 * reported rather than ignored, for the same reason the rate limiter reports
 * one — a limit somebody believes they set and which is not in force is worse
 * than no setting at all.
 */
export function readByteSizeEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback

  const bytes = parseByteSize(raw)
  if (bytes === null) {
    throw new Error(`${name} must be ${BYTE_SIZE_HINT}, got "${raw}"`)
  }
  return bytes
}
