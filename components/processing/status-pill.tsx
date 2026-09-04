import { cn } from "@/lib/utils"

const LABELS: Record<string, string> = {
  uploading: "Uploading",
  queued: "Queued",
  extracting: "Extracting",
  normalizing: "Structuring",
  analyzing: "Analyzing",
  rendering: "Rendering",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
}

export function StatusPill({ status }: { status: string }) {
  const active = !["ready", "failed", "expired"].includes(status)

  return (
    <span
      className={cn(
        "hidden items-center gap-2 rounded-full border px-3 py-1 text-xs sm:flex",
        status === "failed"
          ? "border-red-border text-primary"
          : "border-border text-text-secondary"
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "ready"
            ? "bg-text-secondary"
            : status === "failed"
              ? "bg-primary"
              : "animate-pulse bg-primary"
        )}
      />
      {LABELS[status] ?? status}
      {active ? <span className="sr-only">in progress</span> : null}
    </span>
  )
}
