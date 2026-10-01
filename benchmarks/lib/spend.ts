import { costOf } from "./bench"
import type { ModelRates } from "@/lib/ai/usage-types"

/**
 * What this run of `bench:models` spent, model by model and phase by phase.
 *
 * The results files say what each measured phase cost, but not what running
 * the command did: a phase resumed from a checkpoint was partly paid for in
 * an earlier session, a phase skipped as already measured cost nothing, and
 * the throughput sweep is not a run summary at all. This counts the calls
 * this process made, as they are recorded, and prices them at the rates the
 * results are priced at.
 */

export type SpendRow = {
  label: string
  model: string
  phase: string
  documents: number
  calls: number
  inputTokens: number
  outputTokens: number
  /** Null when the model has no price configured. */
  costUsd: number | null
}

type Entry = Omit<SpendRow, "documents" | "costUsd"> & {
  rates: ModelRates | null
  documents: Set<string>
}

export class SpendLedger {
  private entries = new Map<string, Entry>()
  private current: Omit<
    Entry,
    "documents" | "calls" | "inputTokens" | "outputTokens"
  > | null = null

  /** Calls recorded from here on belong to this model and phase. */
  begin(phase: {
    label: string
    model: string
    phase: string
    rates: ModelRates | null
  }) {
    this.current = phase
  }

  record(call: {
    documentId: string
    inputTokens: number
    outputTokens: number
  }) {
    if (!this.current) return
    const key = `${this.current.model}\u0000${this.current.phase}`
    const entry = this.entries.get(key) ?? {
      ...this.current,
      documents: new Set<string>(),
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    entry.documents.add(call.documentId)
    entry.calls++
    entry.inputTokens += call.inputTokens
    entry.outputTokens += call.outputTokens
    this.entries.set(key, entry)
  }

  rows(): SpendRow[] {
    return [...this.entries.values()].map((entry) => ({
      label: entry.label,
      model: entry.model,
      phase: entry.phase,
      documents: entry.documents.size,
      calls: entry.calls,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: costOf(entry, entry.rates),
    }))
  }
}

export type SpendTotal = {
  calls: number
  inputTokens: number
  outputTokens: number
  /** What the priced rows cost; null when nothing was priced. */
  costUsd: number | null
  /** Models that made calls with no price, so the total leaves them out. */
  unpriced: string[]
}

export function spendTotal(rows: SpendRow[]): SpendTotal {
  const priced = rows.filter((row) => row.costUsd !== null)
  return {
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    costUsd: priced.length
      ? Math.round(priced.reduce((sum, row) => sum + row.costUsd!, 0) * 1e6) /
        1e6
      : null,
    unpriced: [
      ...new Set(
        rows
          .filter((row) => row.costUsd === null && row.calls > 0)
          .map((row) => row.label)
      ),
    ],
  }
}

/**
 * The report as aligned columns: one row per model and phase, a subtotal per
 * model when it ran more than one phase, and the total. `money` and `tokens`
 * format the cells, so the terminal and a test read the same table.
 */
export function spendTable(
  rows: SpendRow[],
  format: { money: (usd: number) => string; tokens: (count: number) => string }
): { head: string[]; body: string[][]; total: string[] } {
  const cost = (usd: number | null) =>
    usd === null ? "no price" : format.money(usd)
  const line = (
    label: string,
    phase: string,
    r: Omit<SpendRow, "label" | "model" | "phase">
  ) => [
    label,
    phase,
    String(r.documents),
    String(r.calls),
    format.tokens(r.inputTokens),
    format.tokens(r.outputTokens),
    cost(r.costUsd),
  ]
  const body: string[][] = []
  const models = [...new Set(rows.map((row) => row.model))]
  for (const model of models) {
    const own = rows.filter((row) => row.model === model)
    for (const [i, row] of own.entries())
      body.push(line(i === 0 ? row.label : "", row.phase, row))
    if (own.length > 1) {
      const sub = spendTotal(own)
      body.push(
        line("", "all phases", {
          ...sub,
          documents: Math.max(...own.map((row) => row.documents)),
          costUsd: sub.unpriced.length ? null : sub.costUsd,
        })
      )
    }
  }
  const total = spendTotal(rows)
  return {
    head: [
      "model",
      "phase",
      "docs",
      "calls",
      "tokens in",
      "tokens out",
      "cost",
    ],
    body,
    total: [
      "total",
      "",
      "",
      String(total.calls),
      format.tokens(total.inputTokens),
      format.tokens(total.outputTokens),
      total.costUsd === null
        ? "no price"
        : `${format.money(total.costUsd)}${total.unpriced.length ? "+" : ""}`,
    ],
  }
}
