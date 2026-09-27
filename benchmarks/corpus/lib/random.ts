import { createHash } from "node:crypto"

/**
 * Seeded randomness for the corpus generator.
 *
 * Everything the script decides — which document gets which spec, which value
 * fills which placeholder — is drawn from a stream derived from the run's seed
 * and a string key. The same seed and key always give the same stream, so a
 * document can be rebuilt from its cached model output without the rest of the
 * corpus, and in any order.
 */
export type Rng = {
  /** A float in [0, 1). */
  next(): number
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  /** Picks by weight; weights need not sum to one. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T
  chance(probability: number): boolean
  shuffle<T>(items: readonly T[]): T[]
  /** `count` distinct items, in random order. */
  sample<T>(items: readonly T[], count: number): T[]
  digits(count: number): string
  chars(alphabet: string, count: number): string
}

/** mulberry32: small, fast, and good enough for sampling. Not for secrets. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A 32-bit seed from the run seed and any number of keys. */
export function deriveSeed(seed: number, ...keys: (string | number)[]): number {
  const hash = createHash("sha256")
    .update([seed, ...keys].join("\u0000"))
    .digest()
  return hash.readUInt32BE(0)
}

export function createRng(seed: number, ...keys: (string | number)[]): Rng {
  const next = mulberry32(deriveSeed(seed, ...keys))

  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1))

  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i)
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }

  return {
    next,
    int,
    pick: (items) => items[int(0, items.length - 1)],
    weighted: (entries) => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
      let roll = next() * total
      for (const [value, weight] of entries) {
        roll -= weight
        if (roll < 0) return value
      }
      return entries[entries.length - 1][0]
    },
    chance: (probability) => next() < probability,
    shuffle,
    sample: (items, count) => shuffle(items).slice(0, count),
    digits: (count) => {
      let out = ""
      for (let i = 0; i < count; i++) out += String(int(0, 9))
      return out
    },
    chars: (alphabet, count) => {
      let out = ""
      for (let i = 0; i < count; i++)
        out += alphabet[int(0, alphabet.length - 1)]
      return out
    },
  }
}

/**
 * Splits `total` into integer counts proportional to `weights`, by largest
 * remainder, so the corpus hits a distribution exactly rather than on average.
 */
export function apportion<T extends string>(
  total: number,
  weights: readonly (readonly [T, number])[]
): [T, number][] {
  const sum = weights.reduce((acc, [, weight]) => acc + weight, 0)
  const exact = weights.map(
    ([key, weight]) => [key, (total * weight) / sum] as const
  )
  const counts = exact.map(
    ([key, value]) => [key, Math.floor(value)] as [T, number]
  )
  let remaining = total - counts.reduce((acc, [, count]) => acc + count, 0)
  const byRemainder = exact
    .map(([, value], index) => [index, value - Math.floor(value)] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
  for (const [index] of byRemainder) {
    if (remaining <= 0) break
    counts[index][1]++
    remaining--
  }
  return counts
}

/** A list of `total` values that hits `weights` exactly, in seeded order. */
export function quota<T extends string>(
  rng: Rng,
  total: number,
  weights: readonly (readonly [T, number])[]
): T[] {
  const values: T[] = []
  for (const [key, count] of apportion(total, weights)) {
    for (let i = 0; i < count; i++) values.push(key)
  }
  return rng.shuffle(values)
}
