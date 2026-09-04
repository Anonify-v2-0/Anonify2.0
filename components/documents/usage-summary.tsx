"use client"

import { useEffect, useState } from "react"
import { Cpu } from "lucide-react"

import {
  formatCost,
  formatDuration,
  formatTokens,
  type AggregateUsage,
  type DocumentUsage,
} from "@/lib/ai/usage-types"
import { cn } from "@/lib/utils"

/**
 * What the analysis cost.
 *
 * Tokens, duration and call counts are measured, so they are always shown. A
 * currency figure appears only when the operator has configured rates — an
 * invented price is worse than no price, particularly on the page people would
 * use to compare models.
 */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label-micro">{label}</dt>
      <dd className="mt-0.5 text-sm text-white tabular-nums">{value}</dd>
    </div>
  )
}

/** Per-document breakdown, fetched on demand. */
export function DocumentUsageSummary({
  documentId,
  className,
}: {
  documentId: string
  className?: string
}) {
  const [usage, setUsage] = useState<DocumentUsage | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const response = await fetch(`/api/documents/${documentId}/usage`, {
          cache: "no-store",
        })
        if (!response.ok) return
        const payload = (await response.json()) as DocumentUsage
        if (!cancelled) setUsage(payload)
      } catch {
        // The summary is informational; its absence is not an error state.
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [documentId])

  if (!usage || usage.totals.calls === 0) return null

  const cost = formatCost(usage.estimatedCostUsd)

  return (
    <div className={cn("rounded-md border border-border p-3", className)}>
      <p className="flex items-center gap-1.5 text-[11px] text-text-muted">
        <Cpu className="size-3" />
        Analysis used {usage.totals.calls}{" "}
        {usage.totals.calls === 1 ? "model call" : "model calls"}
        {usage.models.length > 0 ? ` · ${usage.models.join(", ")}` : ""}
      </p>

      <dl className="mt-2 grid grid-cols-3 gap-3">
        <Stat label="In" value={formatTokens(usage.totals.inputTokens)} />
        <Stat label="Out" value={formatTokens(usage.totals.outputTokens)} />
        <Stat
          label={cost ? "Cost" : "Time"}
          value={cost ?? formatDuration(usage.totals.durationMs)}
        />
      </dl>
    </div>
  )
}

/** Session-wide totals, given to the component by the server. */
export function AggregateUsageSummary({ usage }: { usage: AggregateUsage }) {
  if (usage.totals.calls === 0) return null

  const cost = formatCost(usage.estimatedCostUsd)

  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="label-micro">Analysis usage</p>
        <p className="text-[11px] text-text-muted">
          {usage.documents} {usage.documents === 1 ? "document" : "documents"} ·{" "}
          {usage.totals.calls} model calls
        </p>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Input tokens" value={formatTokens(usage.totals.inputTokens)} />
        <Stat label="Output tokens" value={formatTokens(usage.totals.outputTokens)} />
        <Stat label="Model time" value={formatDuration(usage.totals.durationMs)} />
        <Stat label="Est. cost" value={cost ?? "rates not set"} />
      </dl>

      {usage.byModel.length > 1 ? (
        <ul className="mt-3 space-y-1 border-t border-border pt-3">
          {usage.byModel.map((model) => (
            <li
              key={model.key}
              className="flex justify-between gap-3 text-[11px] text-text-muted"
            >
              <span className="truncate font-mono">{model.key}</span>
              <span className="shrink-0 tabular-nums">
                {formatTokens(model.inputTokens)} in ·{" "}
                {formatTokens(model.outputTokens)} out
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {cost === null ? (
        <p className="mt-3 text-[11px] leading-relaxed text-text-muted">
          Set <code className="font-mono">AI_PRICE_INPUT_PER_MTOK</code> and{" "}
          <code className="font-mono">AI_PRICE_OUTPUT_PER_MTOK</code> to see an
          estimated cost. Rates are not hardcoded because they change and differ
          per account.
        </p>
      ) : null}
    </section>
  )
}
