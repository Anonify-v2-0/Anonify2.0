import {
  runStructured,
  skipIsFailure,
  type StructuredSkip,
} from "@/lib/ai/gateway"
import { spendAllows, spendStatus } from "@/lib/ai/spend"
import {
  ANALYZE_IMAGE_SYSTEM,
  analyzeImagePrompt,
} from "@/lib/ai/prompts/analyze-image"
import {
  ANALYZE_SPREADSHEET_SYSTEM,
  analyzeSpreadsheetPrompt,
  type ColumnSample,
} from "@/lib/ai/prompts/analyze-spreadsheet"
import {
  CLASSIFY_SYSTEM,
  classifyPrompt,
} from "@/lib/ai/prompts/classify-document"
import {
  DETECT_PII_SYSTEM,
  detectPiiPrompt,
} from "@/lib/ai/prompts/detect-pii"
import {
  VERIFY_SYSTEM,
  verifyDetectionPrompt,
  type VerificationCandidate,
} from "@/lib/ai/prompts/verify-detection"
import {
  classificationSchema,
  columnAnalysisSchema,
  detectionResultSchema,
  imageAnalysisSchema,
  verificationSchema,
  type Classification,
} from "@/lib/ai/schemas/detection"
import { detectPatterns } from "@/lib/redaction/detectors"
import {
  categoryAllowed,
  detectorsFor,
  type Preset,
} from "@/lib/redaction/presets"
import {
  dedupeDetections,
  findAllOccurrences,
  locateInPage,
} from "@/lib/redaction/entities"
import { normalizeValue } from "@/lib/documents/shared/text"
import { serviceLimits } from "@/lib/services/limits"
import type { NormalizedDocument, SpreadsheetSheet } from "@/types/document"
import type { Detection } from "@/types/redaction"

/**
 * Analysis orchestration.
 *
 * The order matters and it is the order that keeps this affordable:
 * deterministic detection first, then one model pass over what is left, then a
 * local search to expand anything global. The model is asked the contextual
 * question once per chunk — never once per occurrence, and never about text a
 * regular expression has already settled.
 */

/** Characters per model call. Small enough to stay fast, large enough for context. */
const CHUNK_CHARS = 6000
/** Deterministic hits at or below this confidence get a contextual second look. */
const VERIFY_BELOW = 0.75
/** Characters of surrounding text sent with a candidate during verification. */
const CONTEXT_WINDOW = 80
/** Sample size for classification. */
const CLASSIFY_SAMPLE = 2000
/** Example values shown per spreadsheet column. */
const COLUMN_SAMPLES = 5

export type AnalysisProgress = (update: {
  stage: "classify" | "detect" | "verify" | "columns" | "image"
  completed: number
  total: number
  detections: number
}) => Promise<void> | void

/**
 * How the model pass was cut short, when it was.
 *
 * A contextual pass that produced nothing because the provider refused looks,
 * from the outside, exactly like one that genuinely found nothing — and the
 * difference is a document reviewed against pattern matching alone. It is
 * carried out of here so the run can say so.
 */
export type AnalysisDegradation = {
  reason: StructuredSkip
  /** Model calls lost to it. */
  calls: number
}

/**
 * The vision pass, which the workflow drives page by page rather than through
 * `analyzeDocument`, so it reports its own skip for the caller to tally.
 */
export type ImageAnalysis = {
  regions: Detection[]
  skipped: StructuredSkip | undefined
}

export type AnalysisResult = {
  detections: Detection[]
  classification: Classification | null
  /** Null when every model call the pass wanted to make was made. */
  degraded: AnalysisDegradation | null
  /** Columns the model judged sensitive as a whole. */
  sensitiveColumns: {
    worksheet: string
    column: number
    header: string
    category: string
    confidence: number
    reason: string
    filledRows: number
    totalRows: number
  }[]
}

/** Runs tasks with a ceiling on how many are in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

/**
 * What the provider refused, and how often.
 *
 * Every model call in this file is allowed to come back empty — that is the
 * contract, and it is why a rate limit cannot cost somebody their document. The
 * cost of that contract is that "the model found nothing" and "the model was
 * never asked" arrive here identically, so the reasons are counted on the way
 * past and reported once at the end.
 *
 * The reason reported is the most *actionable* one rather than the most common.
 * Twelve rate limits and one empty balance is an install that needs its balance
 * topping up, and burying that under the twelve helps nobody. The count is the
 * total lost either way, because that is the size of what the reviewer did not
 * get.
 */
const SKIP_SEVERITY: StructuredSkip[] = [
  "budget",
  "authorization",
  "rate-limit",
  "invalid-output",
  "timeout",
  "provider",
]

class SkipTally {
  private readonly seen = new Set<StructuredSkip>()
  private lost = 0

  note(skip: StructuredSkip | undefined): void {
    if (!skipIsFailure(skip) || skip === undefined) return
    this.seen.add(skip)
    this.lost += 1
  }

  result(): AnalysisDegradation | null {
    if (this.lost === 0) return null
    const reason =
      SKIP_SEVERITY.find((candidate) => this.seen.has(candidate)) ?? "provider"
    return { reason, calls: this.lost }
  }
}

type Chunk = {
  page: number
  /** Offset of this chunk within the page's text. */
  offset: number
  text: string
}

/** Splits pages into model-sized chunks, preferring paragraph boundaries. */
export function chunkPages(
  model: NormalizedDocument,
  chunkChars = CHUNK_CHARS
): Chunk[] {
  const chunks: Chunk[] = []

  for (const page of model.pages) {
    if (page.text.trim().length === 0) continue

    let offset = 0
    while (offset < page.text.length) {
      let end = Math.min(offset + chunkChars, page.text.length)

      if (end < page.text.length) {
        const breakAt = page.text.lastIndexOf("\n", end)
        if (breakAt > offset + chunkChars * 0.5) end = breakAt + 1
      }

      chunks.push({
        page: page.number,
        offset,
        text: page.text.slice(offset, end),
      })
      offset = end
    }
  }

  return chunks
}

async function classify(
  documentId: string,
  model: NormalizedDocument,
  tally: SkipTally
): Promise<Classification | null> {
  const sample =
    model.pages[0]?.text.slice(0, CLASSIFY_SAMPLE) ??
    (model.sheets ?? [])
      .map((sheet) => `${sheet.name}: ${sheet.headers.filter(Boolean).join(", ")}`)
      .join("\n")
      .slice(0, CLASSIFY_SAMPLE)

  if (!sample.trim()) return null

  const { output, skipped } = await runStructured({
    task: "classify",
    documentId,
    system: CLASSIFY_SYSTEM,
    prompt: classifyPrompt(sample),
    schema: classificationSchema,
  })

  tally.note(skipped)
  return output
}

/**
 * Asks the model about one chunk and maps its answers back onto real positions.
 * A reported value that cannot be found in the source is discarded — the model
 * may only point at text, never introduce it.
 */
async function detectInChunk(
  documentId: string,
  chunk: Chunk,
  documentType: string | undefined,
  alreadyFound: string[],
  preset: Preset | null,
  tally: SkipTally
): Promise<Detection[]> {
  const { output, skipped } = await runStructured({
    task: "detect",
    documentId,
    system: DETECT_PII_SYSTEM,
    prompt: detectPiiPrompt({
      documentType,
      content: chunk.text,
      alreadyFound,
      lookFor: preset?.looksFor,
    }),
    schema: detectionResultSchema,
  })

  tally.note(skipped)
  if (!output) return []

  const detections: Detection[] = []
  for (const detection of output.detections) {
    // A preset narrows what the model may propose as well as what the patterns
    // look for. Asking it to stay inside the preset is not the same as it
    // having done so.
    if (!categoryAllowed(preset, detection.category)) continue

    const located = locateInPage(chunk.text, detection.text)
    if (!located) continue

    detections.push({
      text: chunk.text.slice(located.start, located.end),
      category: detection.category,
      confidence: detection.confidence,
      reason: detection.reason,
      global: detection.global,
      page: chunk.page,
      start: chunk.offset + located.start,
      end: chunk.offset + located.end,
    })
  }

  return detections
}

/** Batched contextual check for the shakier deterministic categories. */
async function verifyCandidates(
  documentId: string,
  model: NormalizedDocument,
  candidates: Detection[],
  tally: SkipTally
): Promise<Detection[]> {
  if (candidates.length === 0) return []

  const pageText = new Map(model.pages.map((page) => [page.number, page.text]))

  const payload: VerificationCandidate[] = candidates.map((candidate, index) => {
    const text = pageText.get(candidate.page ?? 1) ?? ""
    const start = Math.max(0, (candidate.start ?? 0) - CONTEXT_WINDOW)
    const end = Math.min(text.length, (candidate.end ?? 0) + CONTEXT_WINDOW)
    return {
      index,
      text: candidate.text,
      category: candidate.category,
      context: text.slice(start, end),
    }
  })

  const { output, skipped } = await runStructured({
    task: "verify",
    documentId,
    system: VERIFY_SYSTEM,
    prompt: verifyDetectionPrompt(payload),
    schema: verificationSchema,
  })

  tally.note(skipped)
  // Without a verdict the candidate stands as the detector reported it: the
  // reviewer sees it with its original confidence and decides.
  if (!output) return candidates

  const verdicts = new Map(output.verdicts.map((v) => [v.index, v]))

  return candidates.flatMap((candidate, index) => {
    const verdict = verdicts.get(index)
    if (!verdict) return [candidate]
    if (!verdict.sensitive) return []
    return [
      {
        ...candidate,
        confidence: verdict.confidence,
        reason: verdict.reason || candidate.reason,
      },
    ]
  })
}

function columnSamples(sheet: SpreadsheetSheet): ColumnSample[] {
  const samples: ColumnSample[] = []

  for (let column = 1; column <= sheet.columnCount; column++) {
    const values: string[] = []
    let filled = 0

    for (const cell of sheet.cells) {
      if (cell.column !== column || cell.row === 1 || !cell.value) continue
      filled += 1
      if (values.length < COLUMN_SAMPLES) values.push(cell.value)
    }

    if (filled === 0) continue

    samples.push({
      index: column,
      header: sheet.headers[column - 1] ?? "",
      samples: values,
      filled,
      total: Math.max(0, sheet.rowCount - 1),
    })
  }

  return samples
}

async function analyzeSheets(
  documentId: string,
  model: NormalizedDocument,
  preset: Preset | null,
  tally: SkipTally
): Promise<AnalysisResult["sensitiveColumns"]> {
  const sensitive: AnalysisResult["sensitiveColumns"] = []

  for (const sheet of model.sheets ?? []) {
    const columns = columnSamples(sheet)
    if (columns.length === 0) continue

    const { output, skipped } = await runStructured({
      task: "columns",
      documentId,
      system: ANALYZE_SPREADSHEET_SYSTEM,
      prompt: analyzeSpreadsheetPrompt({
        sheetName: sheet.name,
        rowCount: sheet.rowCount,
        columns,
      }),
      schema: columnAnalysisSchema,
    })

    tally.note(skipped)
    if (!output) continue

    for (const column of output.columns) {
      if (!column.sensitive) continue
      if (!categoryAllowed(preset, column.category)) continue

      // The same rule the text pass follows: a model points at what is there,
      // it does not introduce it. Asked about a four-column sheet, one model
      // answered about columns 1-8, and those four phantoms became four
      // suggestions naming columns that do not exist.
      const sample = columns.find((candidate) => candidate.index === column.index)
      if (!sample) continue

      sensitive.push({
        worksheet: sheet.name,
        column: sample.index,
        // The sheet's header, not the reported one, so a misremembered name
        // cannot end up labelling the redaction a person reviews.
        header: sample.header,
        category: column.category,
        confidence: column.confidence,
        reason: column.reason,
        filledRows: sample.filled,
        totalRows: sample.total,
      })
    }
  }

  return sensitive
}

/**
 * Vision pass: faces and sensitive regions, in normalized coordinates.
 *
 * Takes a page number because this is not only for uploaded images. A PDF page
 * that paints an image gets rasterized and sent here too — a signature or a
 * face on page seven is invisible to every text detector in the pipeline, and
 * was going unflagged.
 */
export async function analyzeImageRegions(
  documentId: string,
  model: NormalizedDocument,
  image: { data: Uint8Array; mediaType: string },
  pageNumber = 1
): Promise<ImageAnalysis> {
  const page =
    model.pages.find((candidate) => candidate.number === pageNumber) ??
    model.pages[0]
  if (!page) return { regions: [], skipped: undefined }

  const { output, skipped } = await runStructured({
    task: "image",
    documentId,
    system: ANALYZE_IMAGE_SYSTEM,
    prompt: analyzeImagePrompt({
      width: page.width,
      height: page.height,
      ocrText: page.text,
    }),
    schema: imageAnalysisSchema,
    images: [image],
  })

  if (!output) return { regions: [], skipped }

  const regions: Detection[] = output.regions.map((region) => ({
    text: region.kind === "face" ? "Face" : region.reason.slice(0, 80),
    category: region.kind === "face" ? "face" : region.category,
    confidence: region.confidence,
    reason: region.reason,
    page: page.number,
    boundingBox: {
      x: region.x * page.width,
      y: region.y * page.height,
      width: region.width * page.width,
      height: region.height * page.height,
    },
  }))

  return { regions, skipped }
}

export async function analyzeDocument(
  documentId: string,
  model: NormalizedDocument,
  onProgress?: AnalysisProgress,
  /**
   * What to look for. `null` is everything, which is what an upload gets unless
   * the person chose otherwise — a missing preset must never narrow the sweep.
   */
  preset: Preset | null = null
): Promise<AnalysisResult> {
  // 1. Deterministic pass. Free, reproducible, and it covers most of the
  //    obvious shapes before a single token is spent.
  const deterministic: Detection[] = []

  const detectors = detectorsFor(preset)

  for (const page of model.pages) {
    deterministic.push(
      ...detectPatterns(page.text, { page: page.number, detectors })
    )
  }

  for (const sheet of model.sheets ?? []) {
    for (const cell of sheet.cells) {
      if (!cell.value) continue
      for (const detection of detectPatterns(cell.value, {
        worksheet: sheet.name,
        detectors,
      })) {
        deterministic.push({
          ...detection,
          start: undefined,
          end: undefined,
          row: cell.row,
          column: cell.column,
        })
      }
    }
  }

  await onProgress?.({
    stage: "detect",
    completed: 0,
    total: 1,
    detections: deterministic.length,
  })

  const tally = new SkipTally()

  // 1a. The day's budget, before anything is spent against it.
  //
  //     Asked once here rather than before every chunk: a hundred chunks is a
  //     hundred aggregate queries for a number that cannot move far between
  //     them, and a call that slips over the line anyway comes back as a 402
  //     the gate already refuses to retry. Over the cap, this behaves exactly
  //     as an install with no key does — deterministic detection, manual
  //     redaction, rules and export all still work — and it says so.
  const spend = await spendStatus()
  if (!spendAllows(spend)) {
    console.warn(
      JSON.stringify({
        level: "warn",
        context: "ai.spend",
        documentId,
        state: spend.state,
        message:
          "The daily spend cap is reached; the contextual pass is skipped for the rest of the UTC day.",
      })
    )
    return {
      detections: dedupeDetections(deterministic),
      classification: null,
      degraded: { reason: "budget", calls: 0 },
      sensitiveColumns: [],
    }
  }

  // 2. Classification, from a small sample.
  const classification = await classify(documentId, model, tally)
  await onProgress?.({
    stage: "classify",
    completed: 1,
    total: 1,
    detections: deterministic.length,
  })

  // 3. Contextual pass over the text, chunked and run in parallel.
  //
  //    The ceiling is configuration and it is process-wide, which is the fix
  //    rather than a detail: it used to be a constant applied per *document*,
  //    so six documents processing at once meant twenty-four concurrent calls
  //    and the number the provider actually saw was one nobody had chosen.
  const alreadyFound = [
    ...new Set(deterministic.map((detection) => detection.text)),
  ]
  const chunks = chunkPages(model)
  let completed = 0

  const contextual = (
    await mapWithConcurrency(chunks, serviceLimits("ai").concurrency, async (chunk) => {
      const found = await detectInChunk(
        documentId,
        chunk,
        classification?.documentType,
        alreadyFound,
        preset,
        tally
      )
      completed += 1
      await onProgress?.({
        stage: "detect",
        completed,
        total: chunks.length,
        detections: deterministic.length + found.length,
      })
      return found
    })
  ).flat()

  // 4. Second look at the deterministic hits that depend on context.
  const shaky = deterministic.filter(
    (detection) => detection.confidence <= VERIFY_BELOW
  )
  const solid = deterministic.filter(
    (detection) => detection.confidence > VERIFY_BELOW
  )
  const verified = await verifyCandidates(documentId, model, shaky, tally)
  await onProgress?.({
    stage: "verify",
    completed: 1,
    total: 1,
    detections: solid.length + verified.length + contextual.length,
  })

  // 5. Spreadsheet structure.
  const sensitiveColumns = await analyzeSheets(documentId, model, preset, tally)

  // 6. Expand global values locally. This is the cheap half of the work:
  //    occurrence 2..n costs a string search, not a request.
  const combined = [...solid, ...verified, ...contextual]
  const expanded: Detection[] = []
  const expandedValues = new Set<string>()

  for (const detection of combined) {
    if (!detection.global) continue
    const key = normalizeValue(detection.text)
    if (!key || expandedValues.has(key)) continue
    expandedValues.add(key)

    expanded.push(
      ...findAllOccurrences(model, detection.text, {
        category: detection.category,
        confidence: detection.confidence,
        reason: detection.reason,
      })
    )
  }

  const detections = dedupeDetections([...combined, ...expanded])

  return {
    detections,
    classification,
    degraded: tally.result(),
    sensitiveColumns,
  }
}
