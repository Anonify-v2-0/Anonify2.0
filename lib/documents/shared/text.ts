import type { TextSpan } from "@/types/document"

/**
 * Accumulates spans into a page's flat text stream, keeping every span's
 * offsets pointing at the exact characters it contributed. Offsets are how a
 * detection made against the normalized text finds its way back to a run, a
 * cell or a glyph box at export time.
 */
export class TextStreamBuilder {
  private buffer = ""
  private readonly collected: TextSpan[] = []

  get length(): number {
    return this.buffer.length
  }

  append(
    id: string,
    text: string,
    extra: Omit<TextSpan, "id" | "text" | "start" | "end"> = {}
  ): TextSpan {
    const start = this.buffer.length
    this.buffer += text
    const span: TextSpan = { id, text, start, end: this.buffer.length, ...extra }
    this.collected.push(span)
    return span
  }

  /** Separator text that belongs to no span (spaces, newlines between runs). */
  pad(text: string): void {
    this.buffer += text
  }

  get text(): string {
    return this.buffer
  }

  get spans(): TextSpan[] {
    return this.collected
  }
}

/** Case- and whitespace-folded form used for local entity matching. */
export function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

/** A half-open range of characters within some string. */
export type CharRange = { start: number; end: number }

/**
 * A range plus what goes in its place.
 *
 * Redaction used to be one operation with one outcome, so a plan carried
 * ranges and a single label. It no longer does: an accepted redaction can be
 * masked, pseudonymised, tokenised or encrypted, and which of those it is
 * belongs to the range rather than to the export. `replacement` left undefined
 * means "whatever the plan's label says", which is what every mask still wants
 * and what keeps the older call sites honest.
 */
export type ReplacementRange = CharRange & { replacement?: string }

/** One accepted value and the string that stands in for it. */
export type ValueReplacement = { value: string; replacement?: string }

/**
 * Overlapping ranges collapsed into disjoint ones, in order.
 *
 * Two detectors finding the same value, or a value inside a longer one, both
 * produce overlapping ranges; cutting them one at a time would remove the
 * overlap twice and shift everything after it.
 */
export function mergeRanges<T extends CharRange>(ranges: T[]): T[] {
  const sorted = [...ranges]
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start)

  const merged: T[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
      mergeReplacement(last, range)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * What a merged range is replaced with when the ranges disagreed.
 *
 * Two redactions overlapping with different methods is rare but not
 * impossible — a name inside an address, say, accepted separately. The merged
 * range takes the *stronger* of the two, and removal is always the stronger:
 * emitting a surrogate over characters something else asked to be deleted
 * would substitute where the reviewer asked to remove. The reverse mistake is
 * only ever a lost pseudonym.
 */
function mergeReplacement(into: CharRange, from: CharRange): void {
  const target = into as ReplacementRange
  const source = from as ReplacementRange
  if (target.replacement === undefined) return
  if (source.replacement === undefined || source.replacement.length === 0) {
    target.replacement = source.replacement
  }
}

/**
 * Removes (or replaces) character ranges from a string.
 *
 * A range carrying its own `replacement` uses it; one that does not falls back
 * to the caller's function, which is where a plan-wide label or a plain
 * deletion comes from.
 */
export function cutRanges(
  text: string,
  ranges: ReplacementRange[],
  replacement: (length: number) => string
): string {
  const merged = mergeRanges(ranges)
  let result = ""
  let cursor = 0

  for (const range of merged) {
    const start = Math.max(0, Math.min(range.start, text.length))
    const end = Math.max(start, Math.min(range.end, text.length))
    if (end <= cursor) continue
    result += text.slice(cursor, start)
    result += range.replacement ?? replacement(end - start)
    cursor = end
  }

  return result + text.slice(cursor)
}

/** Finds every occurrence of `needle` in `haystack`, case-insensitively. */
export function findOccurrences(
  haystack: string,
  needle: string,
  caseSensitive = false
): CharRange[] {
  if (!needle) return []
  const source = caseSensitive ? haystack : haystack.toLowerCase()
  const target = caseSensitive ? needle : needle.toLowerCase()

  const ranges: CharRange[] = []
  let index = source.indexOf(target)
  while (index !== -1) {
    ranges.push({ start: index, end: index + target.length })
    index = source.indexOf(target, index + target.length)
  }
  return ranges
}

/**
 * Finding any of many values at once.
 *
 * The safety sweep asks the same question of every part of a document: does
 * any accepted value appear here? Written the obvious way — a loop over the
 * values inside a loop over the parts — that is a product, and the product is
 * only small because most documents repeat the same handful of values. A
 * spreadsheet or a CSV where every row holds a *different* address does not:
 * twenty thousand distinct values against eighty thousand fields is nearly two
 * billion string searches, and a 1.5 MB file took forty seconds to export.
 *
 * So the values are compiled once into an Aho-Corasick automaton and every
 * haystack is scanned once, which makes the sweep linear in the text rather
 * than in the text times the values.
 *
 * Matching is case-insensitive, as the single-value search is. Unlike it, an
 * occurrence overlapping another is reported rather than skipped — that can
 * only widen what gets removed, never narrow it, and the ranges are merged
 * before anything is cut.
 *
 * Each match carries the replacement its value was given, so a sweep can
 * substitute rather than only delete: the occurrence of a name in a hidden
 * sheet gets the same pseudonym as the occurrence the reviewer looked at, and
 * a document does not end up with the value replaced in one place and removed
 * in another.
 */
export type ValueMatcher = {
  /** Every range in `haystack` covered by one of the values. */
  find(haystack: string): ReplacementRange[]
  /** How many distinct values are compiled in. */
  readonly size: number
}

const EMPTY_MATCHER: ValueMatcher = {
  find: () => [],
  size: 0,
}

export function valueMatcher(
  values: (string | ValueReplacement)[]
): ValueMatcher {
  // Folded to lower case and de-duplicated, keeping the first replacement seen
  // for each: two entries that differ only in case are the same value, and the
  // caller decided its replacement once.
  const byNeedle = new Map<string, string | undefined>()
  for (const entry of values) {
    const value = typeof entry === "string" ? entry : entry.value
    const replacement = typeof entry === "string" ? undefined : entry.replacement
    const needle = value.toLowerCase()
    if (needle.length === 0 || byNeedle.has(needle)) continue
    byNeedle.set(needle, replacement)
  }

  const needles = [...byNeedle.keys()]
  const replacements = [...byNeedle.values()]

  if (needles.length === 0) return EMPTY_MATCHER

  // Transitions live in one flat map keyed by node and character rather than a
  // map per node: a trie over twenty thousand addresses is a quarter of a
  // million nodes, and a quarter of a million Maps is the memory this was
  // meant to save. `children` keeps each node's own edges so building the
  // failure links is a walk rather than a scan of every transition per node.
  const transitions = new Map<number, number>()
  const children: number[][][] = [[]]
  const lengths: number[] = [0]
  /** Which value ends at this node, so a match knows what replaces it. */
  const valueAt: number[] = [-1]

  const key = (node: number, code: number) => node * 0x110000 + code

  let nodeCount = 1

  for (const [needleIndex, needle] of needles.entries()) {
    let node = 0
    for (let index = 0; index < needle.length; index++) {
      const code = needle.charCodeAt(index)
      const existing = transitions.get(key(node, code))

      if (existing === undefined) {
        transitions.set(key(node, code), nodeCount)
        children[node].push([code, nodeCount])
        children.push([])
        lengths.push(0)
        valueAt.push(-1)
        node = nodeCount
        nodeCount += 1
      } else {
        node = existing
      }
    }
    lengths[node] = needle.length
    valueAt[node] = needleIndex
  }

  // Failure links, breadth first, plus a link straight to the nearest node
  // that ends a value so reporting a match does not walk the whole chain.
  const fail = new Int32Array(nodeCount)
  const dictionary = new Int32Array(nodeCount).fill(-1)
  const queue: number[] = []

  for (const [, target] of children[0]) {
    fail[target] = 0
    queue.push(target)
  }

  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]
    dictionary[node] =
      lengths[fail[node]] > 0 ? fail[node] : dictionary[fail[node]]

    for (const [code, target] of children[node]) {
      let candidate = fail[node]
      for (;;) {
        const next = transitions.get(key(candidate, code))
        if (next !== undefined) {
          fail[target] = next
          break
        }
        if (candidate === 0) {
          fail[target] = 0
          break
        }
        candidate = fail[candidate]
      }
      queue.push(target)
    }
  }

  return {
    size: needles.length,
    find(haystack: string): ReplacementRange[] {
      const source = haystack.toLowerCase()
      const ranges: ReplacementRange[] = []

      let node = 0
      for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index)

        for (;;) {
          const next = transitions.get(key(node, code))
          if (next !== undefined) {
            node = next
            break
          }
          if (node === 0) break
          node = fail[node]
        }

        for (
          let match = lengths[node] > 0 ? node : dictionary[node];
          match > 0;
          match = dictionary[match]
        ) {
          ranges.push({
            start: index + 1 - lengths[match],
            end: index + 1,
            replacement: replacements[valueAt[match]],
          })
        }
      }

      return ranges
    },
  }
}
