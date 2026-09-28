"use client"

import type { MatchSample } from "@/lib/redaction/search"
import { cn } from "@/lib/utils"

/** Where a sample is, in the words a reviewer uses. */
export function sampleLocation(sample: MatchSample): string {
  if (sample.worksheet) {
    return `${sample.worksheet} · R${sample.row}C${sample.column}`
  }
  return sample.page ? `p. ${sample.page}` : ""
}

/**
 * Matches in context: the match marked, a little text either side. Used by
 * the rule preview, Hush's proposals and the improvement diff alike, so a
 * match looks the same wherever the reviewer is deciding about it.
 */
export function MatchSamples({
  samples,
  tone = "hit",
  label,
}: {
  samples: MatchSample[]
  tone?: "hit" | "gained" | "lost"
  label: string
}) {
  if (samples.length === 0) return null
  return (
    <ul aria-label={label} className="flex flex-col gap-1">
      {samples.map((sample, index) => (
        <li
          key={index}
          className="flex items-baseline gap-2 rounded bg-surface-3 px-2 py-1 font-mono text-[11px] leading-relaxed"
        >
          <span className="w-14 shrink-0 truncate text-text-muted">
            {sampleLocation(sample)}
          </span>
          <span className="min-w-0 break-words text-text-secondary">
            {sample.before}
            <mark
              className={cn(
                "rounded-[2px] px-0.5 text-[#111214]",
                tone === "lost"
                  ? "bg-text-muted line-through"
                  : tone === "gained"
                    ? "bg-search-current"
                    : "bg-search-current"
              )}
            >
              {sample.match}
            </mark>
            {sample.after}
          </span>
        </li>
      ))}
    </ul>
  )
}
