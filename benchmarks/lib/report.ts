import type { ModelResults, RunSummary } from "./bench"
import { REPEAT_BUCKETS } from "./bench"
import { staleParts, type Fingerprint } from "./fingerprint"
import type { Interval } from "./scoring"
import {
  frontier,
  heatmap,
  lines,
  logBars,
  MAX_SERIES,
  paretoFrontier,
  stacked,
  THEMES,
  type Theme,
} from "./svg"

/**
 * From every results file to the charts #59 and CONTRIBUTING §4 ask for,
 * the two #55 adds, what measuring cost, and the Markdown that shows them
 * with their numbers.
 *
 * Pure: `pnpm bench:charts` does the reading and writing. A chart with
 * nothing to draw is left out rather than drawn empty, and the Markdown says
 * which, and why.
 */

export type PatternsBaseline = {
  corpusHash: string | null
  quality: {
    f1: number | null
    recall: number | null
    precision: number | null
    byCategory: Record<string, { recall: number | null; labels: number }>
  }
  documents: number
}

export type Chart = {
  name: string
  title: string
  /** What the chart shows, for the alt text and the screen reader. */
  alt: string
  /** How to read it, one or two sentences, above the chart in the README. */
  reading: string
  svg: Record<Theme["name"], string>
  /** The numbers behind it, as a Markdown table. */
  table: string
}

export type Report = {
  charts: Chart[]
  /** Charts that could not be drawn, and what they need. */
  missing: Array<{ title: string; needs: string }>
  models: ModelResults[]
  /** Left out; `stale` when a rerun or a rescore would bring it back. */
  excluded: Array<{ model: string; reason: string; stale?: boolean }>
  /** Runs whose numbers need a warning beside them. */
  caveats: string[]
}

/**
 * Categories a pattern can check the shape of, then those that need a
 * reader. The heatmap draws them in two groups because the pipeline's
 * premise is that the difference between models shows up in the second.
 */
export const STRUCTURED = [
  "email",
  "phone",
  "url",
  "api-key",
  "bank-account",
  "financial",
  "government-id",
  "customer-id",
]
export const CONTEXTUAL = [
  "person",
  "address",
  "date-of-birth",
  "confidential",
  "other",
]

const LENGTHS = ["short", "medium", "long"]

/** Dollars to two significant figures: $0.0036, $0.013, $0.10, $2.40. */
export function money(value: number): string {
  if (value === 0) return "$0"
  if (value >= 1) return `$${value.toFixed(2)}`
  const digits = Math.max(2, 1 - Math.floor(Math.log10(value)))
  return `$${Number(value.toPrecision(2))
    .toFixed(Math.min(6, digits))
    .replace(/(\.\d{2,}?)0+$/, "$1")}`
}

export function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`
}

function tokens(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}

function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`
  return [
    line(head),
    line(head.map((_, i) => (i === 0 ? "---" : "---:"))),
    ...rows.map(line),
  ].join("\n")
}

function both(draw: (theme: Theme) => string): Record<Theme["name"], string> {
  return Object.fromEntries(
    THEMES.map((theme) => [theme.name, draw(theme)])
  ) as Record<Theme["name"], string>
}

function totalTokens(run: {
  inputTokens: number
  outputTokens: number
}): number {
  return run.inputTokens + run.outputTokens
}

export function buildReport(input: {
  results: ModelResults[]
  baseline: PatternsBaseline | null
  corpusHash: string | null
  context: string
  /** What a model is told today; a result told something else is stale. */
  fingerprint?: Fingerprint | null
}): Report {
  const excluded: Report["excluded"] = []
  const models = input.results
    .filter((r) => {
      if (input.corpusHash && r.corpusHash !== input.corpusHash) {
        excluded.push({
          model: r.label,
          reason:
            "measured on another version of the corpus; rescore it with pnpm corpus:score --rescore, or rerun with --replace",
          stale: true,
        })
        return false
      }
      const run = r.runs["deterministic-first"] ?? r.runs["model-only"]
      const stale = input.fingerprint
        ? staleParts(run?.fingerprint, input.fingerprint)
        : []
      if (stale.length > 0) {
        excluded.push({
          model: r.label,
          reason: stale.includes("unrecorded")
            ? "measured before results recorded what the model was told, so it cannot be shown current; rerun with --replace"
            : `measured against other ${stale.map((part) => FINGERPRINT_PARTS[part as keyof Fingerprint]).join(" and ")}; rerun with --replace`,
          stale: true,
        })
        return false
      }
      return true
    })
    .sort((a, b) => a.firstMeasuredAt.localeCompare(b.firstMeasuredAt))
  const baseline =
    input.baseline &&
    (!input.corpusHash || input.baseline.corpusHash === input.corpusHash)
      ? input.baseline
      : null

  // A model's colour is its place in the order it was first measured, and
  // stays with it; past eight, a model is drawn without a hue of its own.
  const slot = new Map(models.map((m, i) => [m.model, i]))
  const hued = models.filter((m) => slot.get(m.model)! < MAX_SERIES)
  const charts: Chart[] = []
  const missing: Report["missing"] = []
  const first = (m: ModelResults) => m.runs["deterministic-first"]
  const sample = sampleNote(models)
  const context = sample ? `${input.context} · ${sample}` : input.context

  // 1. Cost per document by model, page count held constant. A model that
  // cost nothing (a local server) has no place on a log scale; the tables
  // still carry it.
  const priced = models.filter((m) => (first(m)?.totals.costUsd ?? 0) > 0)
  if (priced.length > 0) {
    const rows = priced.map((m) => ({
      label: m.label,
      values: LENGTHS.map(
        (length) => first(m)!.byLength[length]?.costPerDocumentUsd ?? null
      ),
    }))
    charts.push({
      name: "cost-per-document",
      title: "Cost per document, by model",
      alt: "Horizontal bars on a log scale: dollars per document for each model, one bar per document length.",
      reading:
        "Each colour is one length of document, so page count is held constant within it; the scale is logarithmic, so equal steps are ten times the cost.",
      svg: both((theme) =>
        logBars(theme, {
          title: "Cost per document, by model",
          subtitle: `${context} · deterministic-first · log scale`,
          note: "Tokens times each model's configured price. Short is up to a page, medium two to five, long ten to thirty.",
          series: LENGTHS.map((l) => `${l} documents`),
          rows,
          format: money,
        })
      ),
      table: table(
        ["Model", "Short", "Medium", "Long", "All"],
        priced.map((m) => [
          m.label,
          ...LENGTHS.map((l) => {
            const v = first(m)!.byLength[l]?.costPerDocumentUsd
            return v == null ? "—" : money(v)
          }),
          money(first(m)!.perDocument.costUsd ?? 0),
        ])
      ),
    })
  } else
    missing.push({
      title: "Cost per document",
      needs: "a model with a price in AI_MODEL_PRICES, that made model calls",
    })

  // 2. Cost against quality, one point per model.
  const points = priced
    .filter(
      (m) =>
        (first(m)!.perDocument.costUsd ?? 0) > 0 &&
        first(m)!.quality.f1 !== null
    )
    .map((m) => ({
      label: m.label,
      x: first(m)!.perDocument.costUsd!,
      y: first(m)!.quality.f1!,
    }))
  if (points.length > 0) {
    const onFrontier = new Set(paretoFrontier(points).map((p) => p.label))
    charts.push({
      name: "cost-quality-frontier",
      title: "What each model buys: cost against F1",
      alt: "Scatter of dollars per document against F1, one point per model, with the frontier of models nothing cheaper beats joined by a line.",
      reading:
        "A model on the line is one no cheaper model beats; a point below and to the right of it costs more for less. The level line is the patterns alone, which cost nothing.",
      svg: both((theme) =>
        frontier(theme, {
          title: "What each model buys: cost against F1",
          subtitle: `${context} · deterministic-first · cost on a log scale`,
          note: "F1 from covered recall and precision over every category.",
          xLabel: "dollars per document",
          yLabel: "F1",
          points,
          baseline:
            baseline?.quality.f1 != null
              ? { label: "patterns alone, at $0", y: baseline.quality.f1 }
              : undefined,
          formatX: money,
          formatY: (v) => `${Math.round(v * 100)}%`,
        })
      ),
      table: table(
        ["Model", "$ / document", "F1", "Recall", "Precision", "Frontier"],
        [
          ...(baseline
            ? [
                [
                  "patterns alone",
                  "$0",
                  percent(baseline.quality.f1),
                  percent(baseline.quality.recall),
                  percent(baseline.quality.precision),
                  "",
                ],
              ]
            : []),
          ...priced.map((m) => {
            const run = first(m)!
            return [
              m.label,
              money(run.perDocument.costUsd ?? 0),
              percent(run.quality.f1),
              percent(run.quality.recall),
              percent(run.quality.precision),
              onFrontier.has(m.label) ? "yes" : "",
            ]
          }),
        ]
      ),
    })
  } else
    missing.push({
      title: "Cost against quality",
      needs: "a priced model with a deterministic-first run",
    })

  // 3. Tokens saved by the deterministic pass, per document type.
  const paired = models.filter(
    (m) =>
      first(m) &&
      m.runs["model-only"] &&
      totalTokens(m.runs["model-only"]!.totals) > 0
  )
  if (paired.length > 0) {
    const panels = paired.map((m) => {
      const w = first(m)!
      const wo = m.runs["model-only"]!
      const types = Object.keys(w.byDocType).filter((t) => wo.byDocType[t])
      return {
        title: m.label,
        rows: types.map((type) => {
          const spent = w.byDocType[type].tokensPerDocument
          const without = wo.byDocType[type].tokensPerDocument
          return {
            label: type,
            segments:
              spent <= without
                ? [spent, without - spent, 0]
                : [without, 0, spent - without],
            total: `${tokens(without)} without · ${pctChange(spent, without)}`,
          }
        }),
      }
    })
    charts.push({
      name: "token-savings",
      title: "Tokens the deterministic pass saves, by document type",
      alt: "Stacked horizontal bars per document type and model: tokens spent with the patterns first, and the tokens saved against the same model with the patterns off.",
      reading:
        "The whole bar is what the model spends on a document when nothing is settled before it is asked. The first segment is what it spends with the patterns first; the second is the saving. A third segment would mean the patterns cost more than they save.",
      svg: both((theme) =>
        stacked(theme, {
          title: "Tokens the deterministic pass saves, by document type",
          subtitle: `${context} · tokens per document, input and output`,
          note: "Same documents, same model, same prompts; the only difference is whether the patterns run first.",
          series: [
            "spent, patterns first",
            "saved by the patterns",
            "spent beyond model-only",
          ],
          panels,
          format: tokens,
        })
      ),
      table: table(
        ["Model", "Document type", "Patterns first", "Model only", "Saved"],
        paired.flatMap((m) => {
          const w = first(m)!
          const wo = m.runs["model-only"]!
          return Object.keys(w.byDocType)
            .filter((t) => wo.byDocType[t])
            .map((t) => [
              m.label,
              t,
              tokens(w.byDocType[t].tokensPerDocument),
              tokens(wo.byDocType[t].tokensPerDocument),
              pctChange(
                w.byDocType[t].tokensPerDocument,
                wo.byDocType[t].tokensPerDocument
              ),
            ])
        })
      ),
    })
  } else
    missing.push({
      title: "Token savings",
      needs:
        "a model with both the deterministic-first and model-only phases, that made model calls",
    })

  // 4. Throughput against concurrency.
  const swept = hued.filter(
    (m) => m.throughput && m.throughput.points.length > 0
  )
  if (swept.length > 0) {
    const levels = [
      ...new Set(
        swept.flatMap((m) => m.throughput!.points.map((p) => p.concurrency))
      ),
    ].sort((a, b) => a - b)
    charts.push({
      name: "throughput",
      title: "Throughput against concurrency",
      alt: "Lines of documents per minute against the number of documents and model calls in flight, one line per model.",
      reading:
        "Where a line flattens, adding concurrency stops buying throughput; a hollow marker is a level where the provider cut the model pass short, which is where its rate limit bites.",
      svg: both((theme) =>
        lines(theme, {
          title: "Throughput against concurrency",
          subtitle: `${context} · the same sample of documents at each level`,
          note: "Concurrency is documents and model calls in flight at once (ANONIFY_AI_CONCURRENCY). One run, one afternoon, one network.",
          x: levels.map(String),
          xLabel: "in flight at once",
          yLabel: "documents per minute",
          series: swept.map((m) => ({
            label: m.label,
            slot: slot.get(m.model)!,
            values: levels.map(
              (l) =>
                m.throughput!.points.find((p) => p.concurrency === l)
                  ?.documentsPerMinute ?? null
            ),
            flagged: levels.map((l) => {
              const p = m.throughput!.points.find((q) => q.concurrency === l)
              return p ? Object.keys(p.degraded).length > 0 : false
            }),
          })),
          format: (v) => v.toFixed(v >= 10 ? 0 : 1),
          flagLabel: "the model pass was cut short at this level",
        })
      ),
      table: table(
        ["Model", ...levels.map((l) => `${l} at once`), "Cut short"],
        swept.map((m) => [
          m.label,
          ...levels.map((l) => {
            const p = m.throughput!.points.find((q) => q.concurrency === l)
            return p ? `${p.documentsPerMinute.toFixed(1)}/min` : "—"
          }),
          m
            .throughput!.points.filter((p) => Object.keys(p.degraded).length)
            .map(
              (p) =>
                `${p.concurrency}: ${Object.entries(p.degraded)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(", ")}`
            )
            .join("; ") || "never",
        ])
      ),
    })
  } else
    missing.push({
      title: "Throughput",
      needs: "a model with the throughput phase",
    })

  // 5. Recall by category, model against category.
  const measured = models.filter((m) => first(m))
  if (measured.length > 0) {
    const columns = [...STRUCTURED, ...CONTEXTUAL]
    const rows = [
      ...(baseline
        ? [{ label: "patterns alone", byCategory: baseline.quality.byCategory }]
        : []),
      ...measured.map((m) => ({
        label: m.label,
        byCategory: first(m)!.quality.byCategory,
      })),
    ]
    const values = rows.map((r) =>
      columns.map((c) =>
        r.byCategory[c]?.labels ? r.byCategory[c].recall : null
      )
    )
    charts.push({
      name: "recall-heatmap",
      title: "Recall by category",
      alt: "Heatmap of covered recall, one row per model and one column per category, structured categories first and contextual ones after.",
      reading:
        "Darker is more of that category found in full. The premise is that a small model does as well as a large one on the structured half, where the patterns do the work, and worse on the contextual half; if the rows do not differ on the right, the premise is wrong.",
      svg: both((theme) =>
        heatmap(theme, {
          title: "Recall by category",
          subtitle: `${context} · covered recall: every character of the value redacted`,
          note: "A partly covered value counts as missed, because what is left can be read.",
          rows: rows.map((r) => r.label),
          columns,
          groups: [
            { label: "structured", from: 0, to: STRUCTURED.length - 1 },
            {
              label: "contextual",
              from: STRUCTURED.length,
              to: columns.length - 1,
            },
          ],
          values,
          format: (v) => `${Math.round(v * 100)}`,
        })
      ),
      table: table(
        ["Model", ...columns],
        rows.map((r, i) => [
          r.label,
          ...values[i].map((v) =>
            v === null ? "—" : `${Math.round(v * 100)}%`
          ),
        ])
      ),
    })
  } else
    missing.push({
      title: "Recall by category",
      needs: "a model with a deterministic-first run",
    })

  // 6. (#55) Where the covered labels came from.
  if (measured.length > 0) {
    const SOURCES = ["patterns", "model", "local search", "only together"]
    charts.push({
      name: "sources",
      title: "Where the result comes from",
      alt: "Stacked bars per model, each 100%: the share of covered labels the patterns, the model, the local search, and only their combination covered.",
      reading:
        "Each covered label is credited to the first pass that covers it alone, in the order the pipeline runs them. The local search share is what expansion adds on top of the model's own answers.",
      svg: both((theme) =>
        stacked(theme, {
          title: "Where the result comes from",
          subtitle: `${context} · share of covered labels, deterministic-first`,
          note: "Only together: a value no single pass covered in full, such as a name the model found half of.",
          series: SOURCES,
          scale: "share",
          panels: [
            {
              rows: measured.map((m) => {
                const a = first(m)!.attribution
                return {
                  label: m.label,
                  segments: [a.patterns, a.model, a.expansion, a.together],
                  total: `${a.covered} of ${a.labels}`,
                }
              }),
            },
          ],
          format: (v) => String(v),
        })
      ),
      table: table(
        [
          "Model",
          "Covered",
          "Patterns",
          "Model",
          "Local search",
          "Only together",
          "Rejected by verification",
        ],
        measured.map((m) => {
          const a = first(m)!.attribution
          const share = (n: number) => percent(a.covered ? n / a.covered : null)
          return [
            m.label,
            `${a.covered} of ${a.labels}`,
            share(a.patterns),
            share(a.model),
            share(a.expansion),
            share(a.together),
            // Wrong rejections, over a labelled value, once a run records them (#212).
            a.detections.rejectedLabelled === undefined
              ? String(a.detections.rejected)
              : `${a.detections.rejected} (${a.detections.rejectedLabelled} of them labelled values)`,
          ]
        })
      ),
    })
  }

  // 7. (#55) What local expansion adds, as values repeat.
  const expanding = hued.filter((m) => first(m)?.expansion.length)
  if (expanding.length > 0) {
    const buckets = REPEAT_BUCKETS.map(([b]) => b).filter((b) =>
      expanding.some((m) => first(m)!.expansion.some((e) => e.bucket === b))
    )
    charts.push({
      name: "expansion",
      title: "What local expansion adds as values repeat",
      alt: "Lines of occurrences added by local search per document against how often each cast member is mentioned, one line per model.",
      reading:
        "Each occurrence the local search adds is one the model did not have to find; the pipeline never asks per occurrence, so this is the most a per-occurrence design would have spent on top.",
      svg: both((theme) =>
        lines(theme, {
          title: "What local expansion adds as values repeat",
          subtitle: `${context} · occurrences added per document, deterministic-first`,
          note: "Repetition is the mean number of mentions per cast member in the document's spec.",
          x: buckets,
          xLabel: "mentions per cast member",
          yLabel: "occurrences added per document",
          series: expanding.map((m) => ({
            label: m.label,
            slot: slot.get(m.model)!,
            values: buckets.map(
              (b) =>
                first(m)!.expansion.find((e) => e.bucket === b)
                  ?.addedPerDocument ?? null
            ),
          })),
          format: (v) => v.toFixed(v >= 10 ? 0 : 1),
        })
      ),
      table: table(
        [
          "Model",
          "Mentions",
          "Documents",
          "Added",
          "Per document",
          "Labels only expansion covered",
        ],
        expanding.flatMap((m) =>
          first(m)!.expansion.map((e) => [
            m.label,
            e.bucket,
            String(e.documents),
            String(e.added),
            e.addedPerDocument.toFixed(2),
            String(e.labelsOnlyByExpansion),
          ])
        )
      ),
    })
  }

  // 8. What measuring cost: every phase's tokens, input and output, and their
  // price. The other charts are per document; this is the whole bill, so
  // whoever reruns a model knows what they are signing up for.
  const spent = spendRows(models)
  if (spent.length > 0) {
    const phases = [...new Set(spent.map((r) => r.phase))]
    const cost = (usd: number | null) =>
      usd === null ? "no price" : money(usd)
    charts.push({
      name: "tokens-and-cost",
      title: "Tokens spent and what they cost",
      alt: "Stacked horizontal bars, one panel per phase and one bar per model: input and output tokens for the whole phase, labelled with the total and its cost.",
      reading:
        "Each bar is everything a model spent on one phase, input tokens then output tokens, labelled with the total and its price. The sum of a model's bars is what benchmarking it cost.",
      svg: both((theme) =>
        stacked(theme, {
          title: "Tokens spent and what they cost",
          subtitle: `${context} · every document of each phase, input and output`,
          note: "Cost is tokens times each model's configured price, as in the other charts. The two verification calls a model gets first are not counted.",
          series: ["input tokens", "output tokens"],
          panels: phases.map((phase) => ({
            title: PHASE_TITLES[phase] ?? phase,
            rows: spent
              .filter((r) => r.phase === phase)
              .map((r) => ({
                label: r.label,
                segments: [r.inputTokens, r.outputTokens],
                total: `${tokens(r.inputTokens + r.outputTokens)} · ${cost(r.costUsd)}`,
              })),
          })),
          format: tokens,
        })
      ),
      table: table(
        [
          "Model",
          "Phase",
          "Documents",
          "Input tokens",
          "Output tokens",
          "Total tokens",
          "Cost",
        ],
        models.flatMap((m) => {
          const own = spent.filter((r) => r.model === m.model)
          if (own.length === 0) return []
          const row = (phase: string, r: Omit<SpendSummary, "phase">) => [
            m.label,
            phase,
            String(r.documents),
            tokens(r.inputTokens),
            tokens(r.outputTokens),
            tokens(r.inputTokens + r.outputTokens),
            cost(r.costUsd),
          ]
          const rows = own.map((r) => row(PHASE_TITLES[r.phase] ?? r.phase, r))
          if (own.length > 1)
            rows.push(
              row("all phases", {
                label: m.label,
                model: m.model,
                documents: own.reduce((sum, r) => sum + r.documents, 0),
                inputTokens: own.reduce((sum, r) => sum + r.inputTokens, 0),
                outputTokens: own.reduce((sum, r) => sum + r.outputTokens, 0),
                costUsd: own.every((r) => r.costUsd !== null)
                  ? own.reduce((sum, r) => sum + r.costUsd!, 0)
                  : null,
              })
            )
          return rows
        })
      ),
    })
  } else
    missing.push({
      title: "Tokens spent and what they cost",
      needs: "a model with a measured phase that made model calls",
    })

  // A run whose model pass was cut short is partly the patterns alone, and
  // reads as a worse model unless it says so.
  const caveats = models.flatMap((m) =>
    Object.values(m.runs)
      .filter((run) => run && run.degraded.documents > 0)
      .map(
        (run) =>
          `${m.label}, ${run!.mode}: the model pass was cut short on ${run!.degraded.documents} of ${run!.documents} documents (${Object.entries(
            run!.degraded.reasons
          )
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")}), so those documents were scored on the patterns alone`
      )
  )

  // Detections the corpus cannot judge, said rather than dropped quietly.
  for (const m of models) {
    for (const run of Object.values(m.runs)) {
      const unscored = Object.entries(run?.quality.unscored ?? {})
      if (!run || unscored.length === 0) continue
      caveats.push(
        `${m.label}, ${run.mode}: ${unscored
          .map(([category, n]) => `${n} ${category}`)
          .join(
            ", "
          )} detections are not scored, because the corpus does not label that category`
      )
    }
  }

  return { charts, missing, models, excluded, caveats }
}

const PHASE_TITLES: Record<string, string> = {
  "deterministic-first": "Deterministic-first",
  "model-only": "Model-only",
  throughput: "Throughput sweep, every level",
}

export type SpendSummary = {
  label: string
  model: string
  phase: string
  /** Documents analysed; for the sweep, every level's sample counted again. */
  documents: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

/**
 * Every measured phase's whole spend, from the results files. A sweep
 * measured before its points recorded tokens is left out rather than
 * guessed from its rates, and a phase that made no call has nothing to draw.
 */
export function spendRows(models: ModelResults[]): SpendSummary[] {
  const rows: SpendSummary[] = []
  for (const m of models) {
    for (const mode of ["deterministic-first", "model-only"] as const) {
      const run = m.runs[mode]
      if (!run || totalTokens(run.totals) === 0) continue
      rows.push({
        label: m.label,
        model: m.model,
        phase: mode,
        documents: run.documents,
        inputTokens: run.totals.inputTokens,
        outputTokens: run.totals.outputTokens,
        costUsd: run.totals.costUsd,
      })
    }
    const points = m.throughput?.points ?? []
    if (points.length > 0 && points.every((p) => p.inputTokens !== undefined)) {
      const inputTokens = points.reduce((sum, p) => sum + p.inputTokens!, 0)
      const outputTokens = points.reduce((sum, p) => sum + p.outputTokens!, 0)
      if (inputTokens + outputTokens > 0)
        rows.push({
          label: m.label,
          model: m.model,
          phase: "throughput",
          documents: points.reduce((sum, p) => sum + p.documents, 0),
          inputTokens,
          outputTokens,
          costUsd: points.every((p) => typeof p.costUsd === "number")
            ? Math.round(points.reduce((sum, p) => sum + p.costUsd!, 0) * 1e6) /
              1e6
            : null,
        })
    }
  }
  return rows
}

function pctChange(spent: number, without: number): string {
  if (without === 0) return "—"
  const saved = 1 - spent / without
  return saved >= 0
    ? `${(saved * 100).toFixed(0)}% saved`
    : `${(-saved * 100).toFixed(0)}% more`
}

// --- the Markdown -----------------------------------------------------------

function picture(chart: Chart, prefix: string): string {
  return [
    "<picture>",
    `  <source media="(prefers-color-scheme: dark)" srcset="${prefix}${chart.name}-dark.svg">`,
    `  <img alt="${chart.alt.replace(/"/g, "&quot;")}" src="${prefix}${chart.name}-light.svg" width="880">`,
    "</picture>",
  ].join("\n")
}

function stageTable(models: ModelResults[]): string | null {
  const runs = models
    .map((m) => [m, m.runs["deterministic-first"]] as const)
    .filter((pair): pair is readonly [ModelResults, RunSummary] =>
      Boolean(pair[1])
    )
  if (runs.length === 0) return null
  const ms = (t: { medianMs: number; p95Ms: number } | null) =>
    t ? `${t.medianMs} / ${t.p95Ms} ms` : "not timed"
  return table(
    ["Model", "Extract + normalize", "Analyze", "Export", "Export failures"],
    runs.map(([m, r]) => [
      m.label,
      ms(r.stages.extract),
      ms(r.stages.analyze),
      ms(r.stages.export),
      String(r.stages.exportFailures.length),
    ])
  )
}

function scalingTable(
  models: ModelResults[],
  key: "byLength" | "byDensity"
): string | null {
  const runs = models.filter((m) => m.runs["deterministic-first"])
  if (runs.length === 0) return null
  const rows: string[][] = []
  for (const m of runs) {
    for (const [group, g] of Object.entries(
      m.runs["deterministic-first"]![key]
    )) {
      rows.push([
        m.label,
        group,
        String(g.documents),
        String(Math.round(g.words / Math.max(1, g.documents))),
        tokens(g.tokensPerDocument),
        g.costPerDocumentUsd === null ? "—" : money(g.costPerDocumentUsd),
        `${(g.medianMs / 1000).toFixed(1)} s`,
        percent(g.recall),
      ])
    }
  }
  return table(
    [
      "Model",
      key === "byLength" ? "Length" : "PII density",
      "Documents",
      "Words",
      "Tokens / doc",
      "$ / doc",
      "Median time",
      "Recall",
    ],
    rows
  )
}

/**
 * Quality by the corpus document's locale, which is how a language change
 * is judged: the English locales should not move, and the others should.
 */
function localeTable(models: ModelResults[]): string | null {
  const rows: string[][] = []
  for (const m of models) {
    for (const [mode, run] of Object.entries(m.runs)) {
      for (const [locale, g] of Object.entries(run?.byLocale ?? {})) {
        rows.push([
          m.label,
          mode,
          locale,
          String(g.documents),
          percent(g.precision),
          percent(g.recall),
          percent(g.f1),
        ])
      }
    }
  }
  if (rows.length === 0) return null
  return table(
    ["Model", "Run", "Locale", "Documents", "Precision", "Recall", "F1"],
    rows
  )
}

const FINGERPRINT_PARTS: Record<keyof Fingerprint, string> = {
  categories: "category definitions",
  detect: "detection prompts",
  verify: "verification prompts",
}

/** "25 of 395 documents", when every model read the same number; or null. */
function sampleNote(models: ModelResults[]): string | null {
  const runs = models.flatMap((m) =>
    Object.values(m.runs).filter((r): r is RunSummary => Boolean(r))
  )
  const counts = new Set(runs.map((r) => r.documents))
  if (counts.size !== 1) return null
  const [documents] = counts
  const of = runs.find((r) => r.selection)?.selection?.of
  return of && of > documents
    ? `${documents} of ${of} documents`
    : `${documents} documents`
}

/** A figure with its interval, when it has one: "87.0% (80.1–92.3%)". */
function withInterval(
  value: number | null,
  interval: [number, number] | null | undefined
): string {
  if (value === null) return "—"
  if (!interval) return percent(value)
  return `${percent(value)} (${(interval[0] * 100).toFixed(1)}–${percent(interval[1])})`
}

function documentsCell(run: RunSummary): string {
  const selection = run.selection
  if (!selection) return `${run.documents}`
  if (selection.how === "all") return `${run.documents}, all`
  const how =
    selection.how === "stratified"
      ? `stratified, seed ${selection.seed}`
      : selection.how === "first"
        ? "the first by id"
        : "chosen by id"
  return `${run.documents} of ${selection.of}, ${how}`
}

const partialRun = (run: RunSummary) =>
  run.selection ? run.selection.how !== "all" : false

/**
 * Every run's headline figures, with how many documents they rest on (#204):
 * a partial run's precision, recall and F1 carry a 95% interval, resampled
 * over its documents. Precision per distinct value sits beside the headline,
 * which counts occurrences (#205).
 */
export function headlineTable(models: ModelResults[]): string | null {
  const rows = models.flatMap((m) =>
    Object.values(m.runs)
      .filter((r): r is RunSummary => Boolean(r))
      .map((run) => {
        const q = run.quality
        const interval: Interval | null | undefined = partialRun(run)
          ? q.interval
          : null
        return [
          m.label,
          run.mode,
          documentsCell(run),
          withInterval(q.precision, interval?.precision),
          withInterval(q.recall, interval?.recall),
          withInterval(q.f1, interval?.f1),
          percent(q.distinct?.precision ?? null),
        ]
      })
  )
  if (rows.length === 0) return null
  return table(
    [
      "Model",
      "Run",
      "Documents",
      "Precision",
      "Recall",
      "F1",
      "Precision, distinct values",
    ],
    rows
  )
}

/** Precision and recall at each confidence cut-off, for runs that recorded confidence (#205). */
export function confidenceTable(models: ModelResults[]): string | null {
  const rows = models.flatMap((m) =>
    Object.values(m.runs)
      .filter((r): r is RunSummary => Boolean(r?.quality.byConfidence))
      .flatMap((run) =>
        run.quality.byConfidence!.map((at) => [
          m.label,
          run.mode,
          `≥ ${at.cutoff}`,
          String(at.detections),
          percent(at.precision),
          percent(at.recall),
        ])
      )
  )
  if (rows.length === 0) return null
  return table(
    ["Model", "Run", "Confidence", "Detections", "Precision", "Recall"],
    rows
  )
}

export const MARKERS = {
  start: "<!-- bench:results:start -->",
  end: "<!-- bench:results:end -->",
}

/** The generated section of benchmarks/README.md. */
export function benchmarksMarkdown(
  report: Report,
  context: string,
  sources: string
): string {
  const out: string[] = [
    MARKERS.start,
    `<!-- Generated by \`pnpm bench:charts\` from ${sources}. Edits here are overwritten. -->`,
    "",
  ]
  if (report.models.length === 0) {
    out.push(
      "No model has been benchmarked on this corpus yet. Run `pnpm bench:models`, then `pnpm bench:charts`, and this section fills itself in.",
      ""
    )
  } else {
    out.push(
      `${context}. ${report.models.length} model${report.models.length === 1 ? "" : "s"}: ${report.models.map((m) => `\`${m.model}\``).join(", ")}. Measured at ${[...new Set(report.models.flatMap((m) => Object.values(m.runs).map((r) => r?.commit)).filter(Boolean))].map((c) => `\`${c}\``).join(", ") || "an unknown commit"}.`,
      ""
    )
    if (report.caveats.length > 0)
      out.push("> [!WARNING]", ...report.caveats.map((c) => `> - ${c}.`), "")
    const headline = headlineTable(report.models)
    if (headline)
      out.push(
        "#### Headline figures",
        "",
        "Precision counts each region a reviewer would see once: a detection inside another is folded into it first. Precision per distinct value counts each value once per document, right if any of its occurrences is. A run of part of the split gives a 95% interval, from resampling its documents.",
        "",
        headline,
        ""
      )
    const confidence = confidenceTable(report.models)
    if (confidence)
      out.push(
        "#### At a confidence cut-off",
        "",
        "What a reviewer would get by hiding every suggestion below a confidence: precision and recall from the detections at or above it.",
        "",
        confidence,
        ""
      )
    for (const chart of report.charts) {
      out.push(
        `#### ${chart.title}`,
        "",
        chart.reading,
        "",
        picture(chart, "charts/"),
        "",
        "<details><summary>The numbers</summary>",
        "",
        chart.table,
        "",
        "</details>",
        ""
      )
    }
    const stages = stageTable(report.models)
    if (stages)
      out.push(
        "#### Wall-clock by stage",
        "",
        "Median and 95th percentile per document. Extraction and export are timed only when the run renders a format (`--format`).",
        "",
        stages,
        ""
      )
    const length = scalingTable(report.models, "byLength")
    if (length) out.push("#### How it scales with length", "", length, "")
    const density = scalingTable(report.models, "byDensity")
    if (density)
      out.push("#### How it scales with PII density", "", density, "")
    const locale = localeTable(report.models)
    if (locale) out.push("#### By language", "", locale, "")
  }
  if (report.missing.length > 0) {
    out.push(
      "Not drawn yet:",
      "",
      ...report.missing.map((m) => `- ${m.title}: needs ${m.needs}.`),
      ""
    )
  }
  if (report.excluded.length > 0) {
    out.push(
      "Left out:",
      "",
      ...report.excluded.map((e) => `- ${e.model}: ${e.reason}.`),
      ""
    )
  }
  const notMeasured = report.models[0]?.notMeasured
  if (notMeasured)
    out.push(
      "What these numbers do not measure:",
      "",
      ...notMeasured.map((n) => `- ${n}`),
      ""
    )
  out.push(MARKERS.end)
  return out.join("\n")
}

/** The generated section of the root README: the two charts that answer the question. */
export function rootMarkdown(report: Report): string {
  const out: string[] = [
    MARKERS.start,
    "<!-- Generated by `pnpm bench:charts`. Edits here are overwritten. -->",
    "",
  ]
  const pick = ["cost-quality-frontier", "recall-heatmap", "token-savings"]
  const charts = report.charts.filter((c) => pick.includes(c.name))
  if (charts.length === 0) {
    out.push(
      "No model has been benchmarked yet. The harness is ready: see [benchmarks/README.md](benchmarks/README.md#benchmarking-models) for the one command that fills this in.",
      ""
    )
  } else {
    for (const chart of charts)
      out.push(picture(chart, "benchmarks/charts/"), "")
    out.push(
      "Every chart, the numbers behind each, and what they do not measure: [benchmarks/README.md](benchmarks/README.md#results).",
      ""
    )
  }
  out.push(MARKERS.end)
  return out.join("\n")
}

/** Replaces the generated section of a document, or says where it is missing. */
export function replaceSection(document: string, section: string): string {
  const start = document.indexOf(MARKERS.start)
  const end = document.indexOf(MARKERS.end)
  if (start === -1 || end === -1 || end < start)
    throw new Error(
      `the document has no ${MARKERS.start} … ${MARKERS.end} section`
    )
  return (
    document.slice(0, start) +
    section +
    document.slice(end + MARKERS.end.length)
  )
}
