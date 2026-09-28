import {
  CATEGORIES,
  type Category,
  type LabelledDocument,
} from "../corpus/lib/types"

/**
 * Scoring a detector against the labelled corpus, as issue #57 specifies it.
 *
 * A detection is matched to a label by character overlap, not by exact
 * offsets, so a redaction that starts a character early still counts:
 *
 * - **covered**: the detections cover every character of the value. A value
 *   partly covered is a leak and counts as missed. This is the primary recall.
 *   Whitespace inside a value need not be covered: "Priya" and "Raman"
 *   redacted separately leave nothing of the name readable.
 * - **overlap**: any detection touches the value.
 * - **strict**: covered by detections of the value's own category, so "found
 *   it but called it the wrong thing" is visible as the gap between the two.
 *
 * A detection that touches no label is a false positive; one over a hard
 * negative is also counted as such, since those were put there to be missed.
 *
 * Misses and false positives are not the same error, so the weighted cost
 * prices them apart. The weights are the starting ones from #57.
 */

export const MISS_WEIGHTS: Record<Category, number> = {
  "government-id": 10,
  "bank-account": 10,
  financial: 10,
  "api-key": 10,
  person: 5,
  address: 5,
  "date-of-birth": 5,
  email: 5,
  phone: 5,
  "customer-id": 5,
  confidential: 2,
  url: 2,
  other: 2,
}

export const FALSE_POSITIVE_WEIGHT = 1

/** A proposed redaction, by offset into the document's text. */
export type Detected = { start: number; end: number; category: string }

type Range = { start: number; end: number }

function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end
}

/** Whether `ranges` together cover every non-whitespace character of `span`. */
export function covers(text: string, span: Range, ranges: Range[]): boolean {
  const touching = ranges
    .filter((range) => overlaps(range, span))
    .sort((a, b) => a.start - b.start)
  let at = span.start
  for (const range of touching) {
    // Skip whitespace between the last covered character and this range.
    while (at < range.start && at < span.end && /\s/.test(text[at])) at++
    if (at >= span.end) return true
    if (range.start > at) return false
    at = Math.max(at, range.end)
  }
  while (at < span.end && /\s/.test(text[at])) at++
  return at >= span.end
}

export type LabelResult = {
  category: Category
  covered: boolean
  overlap: boolean
  strict: boolean
}

export type DetectionResult = {
  category: string
  /** Touches a labelled value of any category. */
  correct: boolean
  /** Touches a labelled value of its own category. */
  strict: boolean
  /** Touches a hard negative and no label. */
  negative: boolean
}

export type DocumentScore = {
  id: string
  docType: string
  labels: LabelResult[]
  detections: DetectionResult[]
}

export function scoreDocument(
  document: LabelledDocument,
  detections: Detected[]
): DocumentScore {
  const labels = document.spans.map((span) => ({
    category: span.category,
    covered: covers(document.text, span, detections),
    overlap: detections.some((detection) => overlaps(detection, span)),
    strict: covers(
      document.text,
      span,
      detections.filter((detection) => detection.category === span.category)
    ),
  }))
  const results = detections.map((detection) => {
    const touched = document.spans.filter((span) => overlaps(detection, span))
    return {
      category: detection.category,
      correct: touched.length > 0,
      strict: touched.some((span) => span.category === detection.category),
      negative:
        touched.length === 0 &&
        document.negatives.some((negative) => overlaps(detection, negative)),
    }
  })
  return {
    id: document.id,
    docType: document.docType,
    labels,
    detections: results,
  }
}

export type CategoryQuality = {
  labels: number
  /** Primary recall: every character covered. */
  recall: number | null
  recallOverlap: number | null
  recallStrict: number | null
  detections: number
  /** Of this category's detections, those touching any label. */
  precision: number | null
  /** Of this category's detections, those touching a label of this category. */
  precisionStrict: number | null
}

export type Quality = {
  labels: number
  detections: number
  precision: number | null
  precisionStrict: number | null
  recall: number | null
  recallOverlap: number | null
  recallStrict: number | null
  /** From precision and covered recall. */
  f1: number | null
  falsePositives: number
  /** False positives that landed on a hard negative. */
  negativeHits: number
  byCategory: Record<string, CategoryQuality>
  weightedCost: {
    total: number
    perDocument: number | null
    missed: Record<string, number>
    falsePositives: number
    weights: { missed: Record<Category, number>; falsePositive: number }
  }
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : round(part / whole)
}

export function round(value: number, places = 4): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

export function aggregate(scores: DocumentScore[]): Quality {
  const labels = scores.flatMap((score) => score.labels)
  const detections = scores.flatMap((score) => score.detections)
  const count = <T>(items: T[], test: (item: T) => boolean) =>
    items.filter(test).length

  const byCategory: Record<string, CategoryQuality> = {}
  for (const category of CATEGORIES) {
    const own = labels.filter((label) => label.category === category)
    const found = detections.filter(
      (detection) => detection.category === category
    )
    byCategory[category] = {
      labels: own.length,
      recall: ratio(
        count(own, (l) => l.covered),
        own.length
      ),
      recallOverlap: ratio(
        count(own, (l) => l.overlap),
        own.length
      ),
      recallStrict: ratio(
        count(own, (l) => l.strict),
        own.length
      ),
      detections: found.length,
      precision: ratio(
        count(found, (d) => d.correct),
        found.length
      ),
      precisionStrict: ratio(
        count(found, (d) => d.strict),
        found.length
      ),
    }
  }

  const missed: Record<string, number> = {}
  let cost = 0
  for (const label of labels) {
    if (label.covered) continue
    missed[label.category] = (missed[label.category] ?? 0) + 1
    cost += MISS_WEIGHTS[label.category]
  }
  const falsePositives = count(detections, (d) => !d.correct)
  cost += falsePositives * FALSE_POSITIVE_WEIGHT

  const precision = ratio(
    count(detections, (d) => d.correct),
    detections.length
  )
  const recall = ratio(
    count(labels, (l) => l.covered),
    labels.length
  )
  return {
    labels: labels.length,
    detections: detections.length,
    precision,
    precisionStrict: ratio(
      count(detections, (d) => d.strict),
      detections.length
    ),
    recall,
    recallOverlap: ratio(
      count(labels, (l) => l.overlap),
      labels.length
    ),
    recallStrict: ratio(
      count(labels, (l) => l.strict),
      labels.length
    ),
    f1:
      precision === null || recall === null || precision + recall === 0
        ? null
        : round((2 * precision * recall) / (precision + recall)),
    falsePositives,
    negativeHits: count(detections, (d) => d.negative),
    byCategory,
    weightedCost: {
      total: cost,
      perDocument: scores.length ? round(cost / scores.length, 2) : null,
      missed,
      falsePositives,
      weights: { missed: MISS_WEIGHTS, falsePositive: FALSE_POSITIVE_WEIGHT },
    },
  }
}

// --- agreement --------------------------------------------------------------

export type Agreement = {
  labels: number
  bothCovered: number
  onlyFirst: number
  onlySecond: number
  neither: number
  /** Share of labels both runs judged the same way. */
  observed: number | null
  /** Cohen's kappa over "covered", chance-corrected. */
  kappa: number | null
  /** Characters either run redacted that both did. */
  redactedJaccard: number | null
  byCategory: Record<
    string,
    { labels: number; observed: number | null; kappa: number | null }
  >
}

function kappa(pairs: Array<[boolean, boolean]>): {
  observed: number | null
  kappa: number | null
} {
  const n = pairs.length
  if (n === 0) return { observed: null, kappa: null }
  const agree = pairs.filter(([a, b]) => a === b).length / n
  const pa = pairs.filter(([a]) => a).length / n
  const pb = pairs.filter(([, b]) => b).length / n
  const chance = pa * pb + (1 - pa) * (1 - pb)
  return {
    observed: round(agree),
    kappa: chance === 1 ? null : round((agree - chance) / (1 - chance)),
  }
}

function redactedCharacters(text: string, ranges: Range[]): Set<number> {
  const characters = new Set<number>()
  for (const range of ranges) {
    for (
      let i = Math.max(0, range.start);
      i < Math.min(text.length, range.end);
      i++
    )
      if (!/\s/.test(text[i])) characters.add(i)
  }
  return characters
}

/**
 * How far two runs agree on the same documents: on each labelled value,
 * whether it was covered, and on every character, whether it was redacted.
 * Only documents both runs scored are compared.
 */
export function agreement(
  documents: LabelledDocument[],
  first: Record<string, Detected[]>,
  second: Record<string, Detected[]>
): Agreement {
  const pairs: Array<[boolean, boolean, Category]> = []
  let union = 0
  let intersection = 0
  for (const document of documents) {
    const a = first[document.id]
    const b = second[document.id]
    if (!a || !b) continue
    for (const span of document.spans) {
      pairs.push([
        covers(document.text, span, a),
        covers(document.text, span, b),
        span.category,
      ])
    }
    const inA = redactedCharacters(document.text, a)
    const inB = redactedCharacters(document.text, b)
    for (const i of inA) if (inB.has(i)) intersection++
    union += new Set([...inA, ...inB]).size
  }
  const byCategory: Agreement["byCategory"] = {}
  for (const category of CATEGORIES) {
    const own = pairs
      .filter(([, , c]) => c === category)
      .map(([a, b]) => [a, b] as [boolean, boolean])
    byCategory[category] = { labels: own.length, ...kappa(own) }
  }
  const overall = kappa(pairs.map(([a, b]) => [a, b]))
  return {
    labels: pairs.length,
    bothCovered: pairs.filter(([a, b]) => a && b).length,
    onlyFirst: pairs.filter(([a, b]) => a && !b).length,
    onlySecond: pairs.filter(([a, b]) => !a && b).length,
    neither: pairs.filter(([a, b]) => !a && !b).length,
    ...overall,
    redactedJaccard: union === 0 ? null : round(intersection / union),
    byCategory,
  }
}
