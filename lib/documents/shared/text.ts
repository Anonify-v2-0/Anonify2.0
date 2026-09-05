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
 * Overlapping ranges collapsed into disjoint ones, in order.
 *
 * Two detectors finding the same value, or a value inside a longer one, both
 * produce overlapping ranges; cutting them one at a time would remove the
 * overlap twice and shift everything after it.
 */
export function mergeRanges(ranges: CharRange[]): CharRange[] {
  const sorted = [...ranges]
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start)

  const merged: CharRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/** Removes (or replaces) character ranges from a string. */
export function cutRanges(
  text: string,
  ranges: CharRange[],
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
    result += replacement(end - start)
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
