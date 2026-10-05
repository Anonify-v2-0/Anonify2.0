import {
  CATEGORIES,
  isCategory,
  type Category,
  type LabelledDocument,
} from "../corpus/lib/types"
import { createRng } from "../corpus/lib/random"

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
 *
 * A detection in a category the corpus does not label, such as `health`, is
 * left out of the score and counted on its own. The corpus cannot say whether
 * it is right, so counting it as a false positive would mark the app down for
 * the corpus's gap, and leaving it out silently would hide it (#197).
 *
 * Precision is counted once per region a reviewer would see (#205). A
 * detection inside another, `Raman` inside `Priya Raman` or inside
 * `priya.raman@example.org`, is folded into the one around it first, so it
 * adds neither a correct detection nor a wrong one. Recall reads every
 * detection: folding changes no character's coverage.
 *
 * Precision per occurrence is the headline. Beside it, precision per distinct
 * value counts each (document, value, category) once, right if any of its
 * occurrences is, so a wrong call the local search copied to every row
 * counts as the one decision it was.
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

/** Which pass of the analysis proposed a detection. */
export type Source = "patterns" | "model" | "expansion"

/** A proposed redaction, by offset into the document's text. */
export type Detected = {
  start: number
  end: number
  category: string
  /** As the analysis reported it. Absent from runs measured before #205. */
  confidence?: number
  source?: Source
}

/** The confidences precision and recall are also reported at. */
export const CONFIDENCE_CUTOFFS = [0.5, 0.7, 0.8, 0.9] as const

/**
 * Drops every detection that lies inside another: one region per redaction a
 * reviewer would see. Of two over the same characters, the more confident
 * one stays, then the first.
 */
export function foldContained<T extends Detected>(detections: T[]): T[] {
  const ordered = detections
    .map((detection, index) => ({ detection, index }))
    .sort(
      (a, b) =>
        a.detection.start - b.detection.start ||
        b.detection.end - a.detection.end ||
        (b.detection.confidence ?? 0) - (a.detection.confidence ?? 0) ||
        a.index - b.index
    )
  const kept: Array<{ detection: T; index: number }> = []
  let reach = -Infinity
  for (const entry of ordered) {
    // By start, longest first: one that ends within the furthest reach so
    // far starts and ends inside a detection already kept.
    if (entry.detection.end <= reach) continue
    kept.push(entry)
    reach = entry.detection.end
  }
  return kept.sort((a, b) => a.index - b.index).map((entry) => entry.detection)
}

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
  /** The text it covers, normalised, for counting distinct values. */
  value: string
  confidence?: number
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
  /** Categories of the detections left out because the corpus does not label them. */
  unscored?: string[]
  /** Detections folded into one around them before counting. */
  merged: number
  /**
   * At each of CONFIDENCE_CUTOFFS, from the detections at or above it: the
   * labels they cover, and how many of them there are and are right. Absent
   * when a detection carries no confidence.
   */
  atConfidence?: Array<{
    cutoff: number
    covered: number
    detections: number
    correct: number
  }>
}

export function scoreDocument(
  document: LabelledDocument,
  all: Detected[]
): DocumentScore {
  const scored = all.filter((detection) => isCategory(detection.category))
  const detections = foldContained(scored)
  const unscored = all
    .filter((detection) => !isCategory(detection.category))
    .map((detection) => detection.category)
  const labels = document.spans.map((span) => ({
    category: span.category,
    covered: covers(document.text, span, scored),
    overlap: scored.some((detection) => overlaps(detection, span)),
    strict: covers(
      document.text,
      span,
      scored.filter((detection) => detection.category === span.category)
    ),
  }))
  const results = detections.map((detection) => {
    const touched = document.spans.filter((span) => overlaps(detection, span))
    return {
      category: detection.category,
      value: document.text
        .slice(detection.start, detection.end)
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase(),
      ...(detection.confidence !== undefined
        ? { confidence: detection.confidence }
        : {}),
      correct: touched.length > 0,
      strict: touched.some((span) => span.category === detection.category),
      negative:
        touched.length === 0 &&
        document.negatives.some((negative) => overlaps(detection, negative)),
    }
  })
  const confident =
    scored.length > 0 && scored.every((d) => d.confidence !== undefined)
  return {
    id: document.id,
    docType: document.docType,
    labels,
    detections: results,
    ...(unscored.length > 0 ? { unscored } : {}),
    merged: scored.length - detections.length,
    ...(confident
      ? {
          atConfidence: CONFIDENCE_CUTOFFS.map((cutoff) => {
            const above = scored.filter((d) => d.confidence! >= cutoff)
            const kept = results.filter((d) => d.confidence! >= cutoff)
            return {
              cutoff,
              covered: document.spans.filter((span) =>
                covers(document.text, span, above)
              ).length,
              detections: kept.length,
              correct: kept.filter((d) => d.correct).length,
            }
          }),
        }
      : {}),
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
  /**
   * Detections folded into one around them before counting precision.
   * Absent from results scored before #205, as are the next three.
   */
  merged?: number
  /** Each (document, value, category) counted once, right if any of its occurrences is. */
  distinct?: { detections: number; precision: number | null }
  /** From the detections at or above each confidence; null when the run recorded none. */
  byConfidence?: Array<{
    cutoff: number
    detections: number
    precision: number | null
    recall: number | null
  }> | null
  /**
   * 95% percentile bootstrap over the documents (#204), for a figure measured
   * on a sample. Only on a whole run's quality, not on its groups.
   */
  interval?: Interval | null
  /**
   * Detections in categories the corpus does not label, by category: not in
   * any figure above, because the corpus cannot judge them.
   */
  unscored: Record<string, number>
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

export type Interval = {
  precision: [number, number] | null
  recall: [number, number] | null
  f1: [number, number] | null
  resamples: number
}

export const RESAMPLES = 2000

function f1Of(precision: number | null, recall: number | null): number | null {
  return precision === null || recall === null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall)
}

/**
 * The documents drawn again with replacement, `resamples` times, and the
 * middle 95% of what each draw scores. Seeded, so the same results give the
 * same interval and a redrawn README does not change by chance.
 */
export function bootstrap(
  scores: DocumentScore[],
  resamples = RESAMPLES
): Interval | null {
  if (scores.length < 2) return null
  const counts = scores.map((score) => ({
    labels: score.labels.length,
    covered: score.labels.filter((l) => l.covered).length,
    detections: score.detections.length,
    correct: score.detections.filter((d) => d.correct).length,
  }))
  const rng = createRng(1, "bootstrap")
  const draws = {
    precision: [] as number[],
    recall: [] as number[],
    f1: [] as number[],
  }
  for (let i = 0; i < resamples; i++) {
    let labels = 0
    let covered = 0
    let detections = 0
    let correct = 0
    for (let j = 0; j < counts.length; j++) {
      const c = counts[rng.int(0, counts.length - 1)]
      labels += c.labels
      covered += c.covered
      detections += c.detections
      correct += c.correct
    }
    const precision = detections ? correct / detections : null
    const recall = labels ? covered / labels : null
    if (precision !== null) draws.precision.push(precision)
    if (recall !== null) draws.recall.push(recall)
    const f1 = f1Of(precision, recall)
    if (f1 !== null) draws.f1.push(f1)
  }
  const middle = (values: number[]): [number, number] | null => {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const at = (p: number) =>
      round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))])
    return [at(0.025), at(0.975)]
  }
  return {
    precision: middle(draws.precision),
    recall: middle(draws.recall),
    f1: middle(draws.f1),
    resamples,
  }
}

export function aggregate(
  scores: DocumentScore[],
  options: { interval?: boolean } = {}
): Quality {
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
  const distinct = new Map<string, boolean>()
  for (const score of scores)
    for (const d of score.detections) {
      const key = `${score.id}\u0000${d.category}\u0000${d.value}`
      distinct.set(key, (distinct.get(key) ?? false) || d.correct)
    }
  const confident = scores.filter((score) => score.atConfidence)
  const byConfidence =
    scores.length > 0 && confident.length === scores.length
      ? CONFIDENCE_CUTOFFS.map((cutoff, i) => {
          const at = confident.map((score) => score.atConfidence![i])
          const found = at.reduce((n, a) => n + a.detections, 0)
          return {
            cutoff,
            detections: found,
            precision: ratio(
              at.reduce((n, a) => n + a.correct, 0),
              found
            ),
            recall: ratio(
              at.reduce((n, a) => n + a.covered, 0),
              labels.length
            ),
          }
        })
      : null
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
    merged: scores.reduce((n, score) => n + (score.merged ?? 0), 0),
    distinct: {
      detections: distinct.size,
      precision: ratio(
        [...distinct.values()].filter(Boolean).length,
        distinct.size
      ),
    },
    byConfidence,
    ...(options.interval ? { interval: bootstrap(scores) } : {}),
    unscored: unscoredCounts(scores),
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

function unscoredCounts(scores: DocumentScore[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const category of scores.flatMap((score) => score.unscored ?? [])) {
    counts[category] = (counts[category] ?? 0) + 1
  }
  return counts
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
