import { renderDocument, type RenderFormat } from "../corpus/lib/render"
import type { LabelledDocument } from "../corpus/lib/types"
import { extract, SourceMap } from "./extraction"
import type { Detected } from "./scoring"
import type { AnalysisPasses } from "@/lib/ai/analyze"
import type { Preset } from "@/lib/redaction/presets"
import type { NormalizedDocument } from "@/types/document"
import type { Detection, Redaction } from "@/types/redaction"

/**
 * Running a corpus document through the pipeline an upload goes through, and
 * measuring it: the model's tokens by task, the wall-clock of each stage, and
 * what each pass of the analysis contributed.
 *
 * Shared by `corpus:score` and `bench:models`.
 */

// --- model usage ------------------------------------------------------------

export type TaskUsage = {
  calls: number
  inputTokens: number
  outputTokens: number
  durationMs: number
}

export type Usage = TaskUsage & { byTask: Record<string, TaskUsage> }

export function emptyUsage(): Usage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    byTask: {},
  }
}

type UsageRow = {
  documentId: string
  task: string
  inputTokens: number
  outputTokens: number
  durationMs: number
}

/**
 * Model usage, per document, as the pipeline records it.
 *
 * `runStructured` writes every call to `prisma.aiUsage`. Here that one table
 * is replaced by a tally, so the benchmark's tokens are counted without a
 * database and never land in the instance's own spend history. `setting`,
 * where a provider keeps a subscription sign-in, goes to `options.setting`
 * when one is given (bench:models keeps its own; see environment.ts).
 * Anything else goes to the real database when DATABASE_URL is set.
 *
 * `onCall` sees each call as it is recorded, for a live view.
 */
export async function captureUsage(
  onCall?: (row: UsageRow) => void,
  options: { setting?: object } = {}
): Promise<Map<string, Usage>> {
  const usage = new Map<string, Usage>()
  const aiUsage = {
    create: async ({ data }: { data: UsageRow }) => {
      const entry = usage.get(data.documentId) ?? emptyUsage()
      addUsage(entry, data)
      const task = (entry.byTask[data.task] ??= {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      })
      addUsage(task, data)
      usage.set(data.documentId, entry)
      onCall?.(data)
      return data
    },
  }
  let real: object | null = null
  if (process.env.DATABASE_URL) {
    const { getPrisma } = await import("@/lib/database/prisma")
    real = getPrisma()
  }
  ;(globalThis as { prisma?: unknown }).prisma = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "aiUsage") return aiUsage
        if (property === "setting" && options.setting) return options.setting
        if (!real) {
          throw new Error(
            `the provider needs the database (prisma.${String(property)}); set DATABASE_URL`
          )
        }
        return Reflect.get(real, property, real)
      },
    }
  )
  return usage
}

function addUsage(into: TaskUsage, row: Omit<UsageRow, "documentId" | "task">) {
  into.calls++
  into.inputTokens += row.inputTokens
  into.outputTokens += row.outputTokens
  into.durationMs += row.durationMs
}

// --- the provider -----------------------------------------------------------

/**
 * Switches the model pass off, exactly as an install with no key runs: the
 * gateway provider with no credential. Detection is then the patterns alone.
 */
export function withoutModel() {
  process.env.AI_PROVIDER = "gateway"
  delete process.env.AI_GATEWAY_API_KEY
  delete process.env.VERCEL_OIDC_TOKEN
}

/**
 * Selects a provider and model for the calls that follow. The provider layer
 * reads the environment on every call and caches no client, so this is all a
 * switch between models takes; each provider's key and settings come from
 * the environment, as they do for the app (for bench:models, its own; see
 * environment.ts).
 */
export function selectModel(provider: string, model: string) {
  process.env.AI_PROVIDER = provider
  process.env.AI_MODEL = model
}

/**
 * The day's spend cap is the instance's, for its users; a benchmark is
 * measuring, and its calls are not recorded against it (see captureUsage).
 */
export function liftSpendCap() {
  process.env.ANONIFY_AI_DAILY_SPEND_USD = "0"
}

/**
 * The analysis with its deterministic pass switched off, for the one number
 * #55 asks for that the app never produces: what the same model spends when
 * nothing has been settled before it is asked.
 *
 * A preset whose detector list is empty runs no pattern (`detectPatterns`
 * treats an empty list as "none" and a missing one as "all"), and with no
 * category list and no `looksFor` the model is asked what it is asked with no
 * preset. The one difference in the prompt is the consequence being measured:
 * its list of values the patterns already found is empty.
 * It is not a preset a person could pick: the schema requires a non-empty
 * list, which is why it is built here rather than in the presets file.
 */
export const MODEL_ONLY = {
  id: "benchmark-model-only",
  detectors: [],
  categories: null,
} as unknown as Preset

// --- one document -----------------------------------------------------------

export type Passes = {
  patterns: Detected[]
  /** Deterministic hits the verification call removed. */
  rejected: number
  model: Detected[]
  expanded: Detected[]
}

export type Analysed = {
  detections: Detected[]
  passes: Passes
  degraded: string | null
  /** Wall-clock by stage. Extraction includes normalization: the app does both in one step. */
  timings: {
    extractMs: number | null
    analyzeMs: number
    exportMs: number | null
  }
  /** For a rendered run, why the export failed, when it did. */
  exportError?: string
  /** For a rendered run: detections that map to no text of the original. */
  outside?: number
  /** For a rendered run: labelled characters recovered, and out of how many. */
  recovered?: [number, number]
  substituted?: number
}

export type AnalyseOptions = {
  /** `null` analyses as an upload with no preset does; see MODEL_ONLY. */
  preset?: Preset | null
  /** Also time the export of every detection, accepted. Rendered formats only. */
  timeExport?: boolean
  /** The stage the document has reached, for a live view. */
  onStage?: (stage: string) => void
}

function labelCharacters(document: LabelledDocument): number {
  let count = 0
  for (const span of document.spans)
    count += span.value.replace(/\s/g, "").length
  return count
}

function onText(detections: Detection[]): Detected[] {
  return detections
    .filter((d) => d.start !== undefined && d.end !== undefined)
    .map((d) => ({ start: d.start!, end: d.end!, category: d.category }))
}

/**
 * Runs one document through analysis. By default it is one plain-text page;
 * with a format it is rendered to that format, read back by the extractor an
 * upload of it goes through, and the detections are carried back to the
 * labels by aligning the extracted text with the original.
 */
export async function analyse(
  document: LabelledDocument,
  format: string,
  options: AnalyseOptions = {}
): Promise<Analysed> {
  const { analyzeDocument } = await import("@/lib/ai/analyze")
  const preset = options.preset ?? null
  const stage = options.onStage ?? (() => {})
  const progress = options.onStage
    ? ({ stage: name }: { stage: string }) => stage(name)
    : undefined

  if (format === "text") {
    stage("patterns")
    const began = performance.now()
    const result = await analyzeDocument(
      document.id,
      {
        documentId: document.id,
        kind: "txt",
        pages: [
          { number: 1, width: 0, height: 0, text: document.text, spans: [] },
        ],
      },
      progress,
      preset
    )
    const analyzeMs = performance.now() - began
    return {
      detections: onText(result.detections),
      passes: mapPasses(result.passes, onText, []),
      degraded: result.degraded?.reason ?? null,
      timings: { extractMs: null, analyzeMs, exportMs: null },
    }
  }

  stage("render")
  const rendered = await renderDocument(document, format as RenderFormat)
  stage("extract")
  const extractStarted = performance.now()
  const model = await extract(document.id, rendered.format, rendered.bytes)
  const extractMs = performance.now() - extractStarted
  const map = new SourceMap(document.text, model)

  stage("patterns")
  const analyzeStarted = performance.now()
  const result = await analyzeDocument(document.id, model, progress, preset)
  const analyzeMs = performance.now() - analyzeStarted

  const carry = (detections: Detection[]) =>
    detections
      .map((d) => map.detection(d))
      .filter((d): d is Detected => d !== null)
  const mapped = result.detections.map((d) => map.detection(d))
  const columns = result.sensitiveColumns.flatMap((column) =>
    map.column(column.worksheet, column.column, column.category)
  )

  let exportMs: number | null = null
  let exportError: string | undefined
  if (options.timeExport) {
    stage("export")
    const exportStarted = performance.now()
    try {
      await exportAll(
        document.id,
        rendered.format,
        rendered.bytes,
        model,
        result.detections
      )
      exportMs = performance.now() - exportStarted
    } catch (error) {
      exportError = (error as Error).message.split("\n")[0].slice(0, 200)
    }
  }

  const total = labelCharacters(document)
  return {
    detections: [
      ...mapped.filter((d): d is Detected => d !== null),
      ...columns,
    ],
    passes: mapPasses(result.passes, carry, columns),
    degraded: result.degraded?.reason ?? null,
    timings: { extractMs, analyzeMs, exportMs },
    exportError,
    outside: mapped.filter((d) => d === null).length,
    recovered: [
      Math.round(map.recovered(document.text, document.spans) * total),
      total,
    ],
    substituted: rendered.substituted,
  }
}

/** A whole sensitive column is the model's judgement, so it counts as the model's. */
function mapPasses(
  passes: AnalysisPasses,
  carry: (detections: Detection[]) => Detected[],
  columns: Detected[]
): Passes {
  return {
    patterns: carry(passes.patterns),
    rejected: passes.rejected,
    model: [...carry(passes.model), ...columns],
    expanded: carry(passes.expanded),
  }
}

/**
 * Exports the document with every detection accepted, as the export stage of
 * a run where the reviewer accepted everything proposed. Whole-column
 * judgements are left out: the reviewer turns those into cell redactions.
 */
async function exportAll(
  documentId: string,
  kind: RenderFormat,
  source: Uint8Array,
  model: NormalizedDocument,
  detections: Detection[]
) {
  const { exportRedacted } = await import("@/lib/redaction/export")
  const redactions: Redaction[] = []
  for (const detection of detections) {
    const base = {
      id: `bench-${redactions.length}`,
      documentId,
      source: "ai" as const,
      category: detection.category,
      status: "accepted" as const,
      text: detection.text,
    }
    if (detection.worksheet && detection.row && detection.column) {
      redactions.push({
        ...base,
        type: "cell",
        worksheet: detection.worksheet,
        row: detection.row,
        column: detection.column,
      })
    } else if (detection.start !== undefined && detection.end !== undefined) {
      redactions.push({
        ...base,
        type: "text",
        page: detection.page,
        start: detection.start,
        end: detection.end,
      })
    }
  }
  await exportRedacted({
    kind,
    source,
    model,
    redactions,
    options: { addLabels: false, sanitizeMetadata: true },
  })
}
