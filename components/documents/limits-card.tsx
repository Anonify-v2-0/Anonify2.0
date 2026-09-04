"use client"

import { useEffect, useState } from "react"
import { Gauge } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  QUOTA_LABELS,
  RATE_LIMIT_LABELS,
  usedFraction,
  type LimitsReport,
} from "@/types/limits"

/**
 * What is left of your allowance.
 *
 * Both limits are server-side and neither was visible anywhere: you found out
 * you had hit one by being refused. Showing them turns a wall into a gauge —
 * and shows the same numbers the server enforces, read through an endpoint that
 * deliberately does not spend from the bucket it is reporting on.
 *
 * Two different things, side by side because hitting either produces the same
 * refusal. A rate limit is pace: requests per window, refilling continuously,
 * back to full within a minute of being left alone. A quota is volume for the
 * UTC day. A self-hosted install has no quotas at all, and says so rather than
 * drawing empty bars for limits that do not exist.
 */

const REFRESH_MS = 15_000

function percent(fraction: number): string {
  // A used allowance should not round to "0% used" just because it is small.
  const value = fraction * 100
  if (value > 0 && value < 1) return "<1%"
  return `${Math.round(value)}%`
}

function Meter({
  label,
  detail,
  fraction,
}: {
  label: string
  detail: string
  fraction: number
}) {
  const share = Math.max(0, Math.min(1, fraction))
  const pressed = share >= 0.9

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-text-secondary">{label}</span>
        <span
          className={cn(
            "text-[11px] tabular-nums",
            pressed ? "text-primary" : "text-text-muted"
          )}
        >
          {detail}
        </span>
      </div>
      <span
        role="progressbar"
        aria-valuenow={Math.round(share * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}, ${percent(share)} used`}
        className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-surface-3"
      >
        <span
          className={cn(
            "block h-full transition-[width] duration-300",
            pressed ? "bg-primary" : "bg-text-muted"
          )}
          style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }}
        />
      </span>
    </div>
  )
}

export function LimitsCard({ className }: { className?: string }) {
  const [report, setReport] = useState<LimitsReport | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function load() {
      try {
        const response = await fetch("/api/limits", { cache: "no-store" })
        if (response.ok && !cancelled) {
          setReport((await response.json()) as LimitsReport)
        }
      } catch {
        // Informational; a missed refresh is not an error state.
      }
      if (!cancelled) timer = setTimeout(load, REFRESH_MS)
    }

    void load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (!report) return null

  // Only what is actually constrained. A rate limit always is; a quota is not
  // on a self-hosted install, and a bar that is always empty teaches nothing.
  const quotas = report.quotas.filter((quota) => quota.limit > 0)
  const spent = report.rateLimits.filter(
    (limit) => limit.remaining < limit.limit
  )

  return (
    <section className={cn("panel p-5", className)}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="label-micro flex items-center gap-2">
          <Gauge aria-hidden className="size-3.5 text-primary" />
          Allowance
        </p>
        <span className="text-[11px] text-text-muted">
          {report.profile === "demo" ? "Shared demo" : "Self-hosted"}
        </span>
      </div>

      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <div className="space-y-3">
          <p className="text-[11px] tracking-wide text-text-muted uppercase">
            Requests
          </p>
          {report.rateLimits.map((limit) => {
            const used = limit.limit - limit.remaining
            const share = usedFraction(used, limit.limit) ?? 0
            return (
              <Meter
                key={limit.name}
                label={RATE_LIMIT_LABELS[limit.name]}
                detail={
                  limit.resetAt
                    ? "none left"
                    : `${percent(share)} of ${limit.limit}/${limit.windowSeconds}s`
                }
                fraction={share}
              />
            )
          })}
        </div>

        <div className="space-y-3">
          <p className="text-[11px] tracking-wide text-text-muted uppercase">
            Today
          </p>
          {quotas.length === 0 ? (
            <p className="text-xs leading-relaxed text-text-muted">
              No daily limits on this install. Pages, cells and uploads are
              counted but nothing is capped — set{" "}
              <code className="text-text-secondary">ANONIFY_QUOTA_*</code> if you
              are running something shared.
            </p>
          ) : (
            quotas.map((quota) => {
              const share = usedFraction(quota.used, quota.limit) ?? 0
              return (
                <Meter
                  key={quota.kind}
                  label={QUOTA_LABELS[quota.kind]}
                  detail={`${percent(share)} of ${quota.limit.toLocaleString()}`}
                  fraction={share}
                />
              )
            })
          )}
        </div>
      </div>

      {spent.length > 0 || quotas.some((quota) => quota.used > 0) ? (
        <p className="mt-4 text-[11px] leading-relaxed text-text-muted">
          Request allowances refill continuously; daily counts reset at midnight
          UTC.
        </p>
      ) : null}
    </section>
  )
}
