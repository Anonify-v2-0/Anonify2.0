import { z } from "zod"

import { unlabelledReferenceCells } from "./columns"
import { inferEntity, repairMarkup, stripMarkup } from "./markup"
import { findDenied, mask } from "./operator"
import { createRng } from "./random"
import { scanForIdentifiers } from "./reserved"
import type {
  Category,
  DocumentSpec,
  LabelledDocument,
  LengthBucket,
  ModelDocument,
  Negative,
  Span,
} from "./types"

/**
 * Turns one model response into a labelled document, or into the list of
 * reasons it was rejected. Pure: the same spec, response and seed always give
 * the same result, which is what lets `--rebuild` re-derive a corpus from
 * cached responses after a fix here without paying for a single token.
 */

const ModelDocumentSchema = z.object({
  title: z.string(),
  docType: z.string(),
  locale: z.string(),
  cast: z.array(z.object({ id: z.string(), name: z.string() })),
  body: z.string().min(1),
  negatives: z.array(z.string()),
})

export type GeneratorInfo = Omit<LabelledDocument["generator"], "markupRepairs">

export type BuildResult =
  | { ok: true; document: LabelledDocument; warnings: string[] }
  | { ok: false; reasons: string[] }

/** Word-count bounds per bucket, looser than the targets: models run short. */
export const WORD_BOUNDS: Record<LengthBucket, [number, number]> = {
  short: [60, 800],
  medium: [500, 4500],
  long: [3000, Infinity],
}

/** Pulls the JSON object out of a response that may carry fences or chatter. */
export function parseModelOutput(raw: string): ModelDocument {
  let text = raw.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text)
  if (fenced) text = fenced[1]
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first === -1 || last < first)
    throw new Error("the response contains no JSON object")
  const parsed = ModelDocumentSchema.safeParse(
    JSON.parse(text.slice(first, last + 1))
  )
  if (!parsed.success) {
    throw new Error(
      `the response does not match the schema: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
    )
  }
  return parsed.data
}

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number }
) {
  return a.start < b.end && a.end > b.start
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Whole-word occurrences, so "Ann" is not found inside "Annual". */
function occurrences(
  text: string,
  value: string
): { start: number; end: number }[] {
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`,
    "gu"
  )
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

/**
 * Words, counted as runs of letters and digits, so a CSV row counts its cells
 * rather than being one "word" with commas in it.
 */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’.@_-][\p{L}\p{N}]+)*/gu) ?? []).length
}

export function buildDocument(
  spec: DocumentSpec,
  raw: string,
  generator: GeneratorInfo,
  options: {
    /** Lower-case strings that identify the operator; see operator.ts. */
    deny?: string[]
  } = {}
): BuildResult {
  let model: ModelDocument
  try {
    model = parseModelOutput(raw)
  } catch (error) {
    return { ok: false, reasons: [(error as Error).message] }
  }

  const reasons: string[] = []
  const warnings: string[] = []

  const cast = new Map<string, string>()
  for (const member of model.cast) {
    // Models sometimes mark up the cast list itself.
    const name = member.name
      .replace(/^\s*\[\[[a-z-]+\|([\s\S]*)\]\]\s*$/, "$1")
      .trim()
    if (name) cast.set(member.id, name)
  }
  for (const member of spec.cast) {
    if (!cast.has(member.id))
      reasons.push(
        `cast member ${member.id} is missing from the response's cast`
      )
  }

  // 1. Markup. Anything malformed rejects: a label that cannot be parsed is a
  // label that cannot be trusted.
  const repaired = repairMarkup(model.body)
  const { text, spans, errors } = stripMarkup(repaired.body, {
    rng: createRng(generator.seed, "fill", spec.id),
    locale: spec.locale,
    cast,
    memo: new Map(),
  })
  reasons.push(...errors)

  for (const span of spans) {
    if (span.category === "person" && !span.entity) {
      const entity = inferEntity(span.value, cast)
      if (entity) span.entity = entity
    }
  }

  // 2. Anything real-looking that is not ours. This is the check that keeps
  // real data out: a model that writes a phone number, email, URL or IP
  // address itself, marked up or not, may be writing one it has seen.
  // Declared negatives exempt nothing here. The scanner already passes over
  // references and SKUs; anything it still reads as an email or a telephone
  // number is one, and is labelled, whatever the model called it.
  let negatives = locateNegatives(text, model.negatives, spans, warnings)
  let autoLabelled = 0
  for (const finding of scanForIdentifiers(text, spec.locale)) {
    // Only a fill that holds the whole finding excuses it: one that merely
    // touches it ("[[api-key|{{SECRET}}]]@gmail.com") leaves the rest the
    // model's own writing.
    const filled = spans.some(
      (span) =>
        span.placeholder &&
        span.start <= finding.start &&
        finding.end <= span.end
    )
    const labelled = spans.some((span) => overlaps(span, finding))

    if (!finding.reserved) {
      if (filled) continue
      reasons.push(
        `${finding.kind} outside the reserved ranges: ${JSON.stringify(finding.value)}`
      )
      continue
    }
    // A reserved email or phone number left unmarked, such as a
    // noreply@…example.com in a config file, has one reading: its shape is its
    // category, and the range it is in says nobody owns it. Label it, like the
    // repairs above, rather than spend a retry.
    if ((finding.kind === "email" || finding.kind === "phone") && !labelled) {
      spans.push({
        start: finding.start,
        end: finding.end,
        category: finding.kind,
        value: finding.value,
      })
      autoLabelled++
    }
  }
  if (autoLabelled > 0) {
    spans.sort((a, b) => a.start - b.start)
    negatives = negatives.filter(
      (negative) => !spans.some((span) => overlaps(span, negative))
    )
  }

  // 3. Labelled once, unlabelled elsewhere. "Mark EVERY occurrence".
  const checked = new Set<string>()
  const repeatables = [
    ...spans
      .filter((span) => !span.placeholder && span.value.length >= 4)
      .map((span) => span.value),
    ...[...cast.values()]
      .flatMap((name) => name.split(/\s+/))
      .filter((part) => /^\p{Lu}\p{L}{2,}$/u.test(part)),
  ]
  for (const value of repeatables) {
    if (checked.has(value)) continue
    checked.add(value)
    for (const occurrence of occurrences(text, value)) {
      if (!spans.some((span) => overlaps(span, occurrence))) {
        reasons.push(
          `unmarked repeat of ${JSON.stringify(value)} at ${occurrence.start}`
        )
        break
      }
    }
  }

  // 3b. A column of references to people, such as customer_ref, that is
  // bare. Step 3 cannot see a value that is never labelled (#202). A decoy in
  // the column, a row id that is nobody's, passes once it is declared a
  // negative.
  if (spec.docType === "tabular export") {
    const bare = unlabelledReferenceCells(text, spans, negatives)
    for (const header of new Set(bare.map((cell) => cell.header))) {
      const cells = bare.filter((cell) => cell.header === header)
      reasons.push(
        `${JSON.stringify(header)} names a reference to a person, but ${cells.length} of its values are unlabelled, such as ${JSON.stringify(cells[0].value)}`
      )
    }
  }

  // 4. The spec.
  if (spec.density === "none") {
    if (spans.length > 0)
      reasons.push(`density "none" but ${spans.length} labelled values`)
    if (negatives.length === 0)
      reasons.push(
        `density "none" but none of the hard negatives appear verbatim`
      )
  } else {
    const present = new Set<Category>(spans.map((span) => span.category))
    for (const category of spec.mustInclude) {
      if (!present.has(category))
        reasons.push(`required category "${category}" is missing`)
    }
  }

  const mentions = new Map<string, number>()
  for (const span of spans) {
    if (span.category === "person" && span.entity) {
      mentions.set(span.entity, (mentions.get(span.entity) ?? 0) + 1)
    }
  }
  for (const member of spec.cast) {
    if (!mentions.get(member.id))
      reasons.push(`cast member ${member.id} (${member.role}) is never named`)
  }

  const words = countWords(text)
  const [minWords, maxWords] = WORD_BOUNDS[spec.length]
  if (words < minWords || words > maxWords) {
    reasons.push(
      `${words} words is outside the "${spec.length}" bucket (${minWords}–${maxWords})`
    )
  }

  for (const finding of scanForIdentifiers(model.title, spec.locale)) {
    if (!finding.reserved)
      reasons.push(
        `title contains a ${finding.kind} outside the reserved ranges`
      )
  }

  // The person running the script. Their account email reaches the model as
  // context, and nothing else here would notice their name.
  if (options.deny?.length) {
    const denied = findDenied(
      [model.title, text, ...cast.values()].join("\n"),
      options.deny
    )
    for (const token of denied) {
      reasons.push(`mentions the operator's identity (${mask(token)})`)
    }
  }

  if (reasons.length > 0) return { ok: false, reasons }

  return {
    ok: true,
    warnings,
    document: {
      id: spec.id,
      split: spec.split,
      title: model.title.trim(),
      docType: spec.docType,
      docTypeDetail: spec.docTypeDetail,
      locale: spec.locale,
      length: spec.length,
      density: spec.density,
      render: spec.render,
      words,
      text,
      spans,
      negatives,
      entities: spec.cast.map((member) => ({
        id: member.id,
        name: cast.get(member.id)!,
        role: member.role,
        requested: member.mentions,
        mentions: mentions.get(member.id) ?? 0,
      })),
      spec: {
        mustInclude: spec.mustInclude,
        negatives: spec.negatives,
        targetWords: spec.targetWords,
      },
      generator: {
        ...generator,
        markupRepairs: repaired.repairs + autoLabelled,
      },
    },
  }
}

/** Every verbatim occurrence of each declared look-alike that is not labelled. */
function locateNegatives(
  text: string,
  declared: string[],
  spans: Span[],
  warnings: string[]
): Negative[] {
  const found: Negative[] = []
  for (const value of new Set(
    declared.map((negative) => negative.trim()).filter(Boolean)
  )) {
    const hits = occurrences(text, value).filter(
      (hit) => !spans.some((span) => overlaps(span, hit))
    )
    if (hits.length === 0) {
      warnings.push(
        `negative ${JSON.stringify(value)} does not appear verbatim`
      )
      continue
    }
    for (const hit of hits) {
      if (!found.some((other) => overlaps(other, hit)))
        found.push({ ...hit, value })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}
