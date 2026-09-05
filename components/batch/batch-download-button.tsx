"use client"

import { useState } from "react"
import { Archive, Check, Loader2 } from "lucide-react"

import { BatchDownloadDialog } from "@/components/batch/batch-download-dialog"
import { Button } from "@/components/ui/button"
import { isActiveExport, useBatchExport } from "@/hooks/use-batch-export"
import { cn } from "@/lib/utils"

/**
 * The one control for getting a batch out, wherever it is offered.
 *
 * It carries the progress itself rather than leaving it in the modal. The run
 * is durable and takes minutes, so the reviewer will close that window — to
 * carry on reviewing, or because they have what they need — and a control that
 * forgot the run the moment it was dismissed would make closing it feel like
 * cancelling. Here the button says "Exporting 3 of 8" while it works, then
 * "Archive ready" when there is something to take.
 *
 * The documents page, the batch page and the workspace all render this, so
 * "get me everything" means one thing in all three.
 */

export function BatchDownloadButton({
  batchId,
  documentCount,
  readyCount,
  label = "Download all",
  labelClassName,
  variant = "default",
  size = "sm",
  className,
}: {
  batchId: string
  documentCount?: number
  /** Documents that have finished processing; none means nothing to export. */
  readyCount?: number
  label?: string
  /** For headers that hide the label at narrow widths. */
  labelClassName?: string
  variant?: "default" | "outline"
  size?: "sm" | "default"
  className?: string
}) {
  const controls = useBatchExport(batchId)
  const [open, setOpen] = useState(false)

  const { state, loading } = controls
  const active = isActiveExport(state)
  const ready = Boolean(state?.downloadUrl)

  const percent =
    active && state && state.total > 0
      ? Math.round((state.completed / state.total) * 100)
      : 0

  const nothingToExport = readyCount === 0 && !active && !ready

  return (
    <>
      <Button
        variant={variant}
        size={size}
        // `relative` and the clipped fill below: the progress is drawn inside
        // the control it belongs to rather than as a second thing to watch.
        className={cn("relative overflow-hidden", className)}
        disabled={loading || nothingToExport}
        title={
          nothingToExport
            ? "Nothing in this batch has finished processing yet"
            : undefined
        }
        aria-label={
          active && state
            ? `Batch export in progress, ${state.completed} of ${state.total} documents`
            : undefined
        }
        onClick={() => setOpen(true)}
      >
        {active ? (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 bg-primary/25 transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        ) : null}

        <span className="relative flex items-center gap-1.5">
          {active ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : ready ? (
            <Check className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
          <span className={labelClassName}>
            {active && state
              ? state.cancelRequested
                ? "Stopping"
                : state.total > 0
                  ? `Exporting ${state.completed} of ${state.total}`
                  : "Preparing"
              : ready
                ? "Archive ready"
                : label}
          </span>
        </span>
      </Button>

      <BatchDownloadDialog
        open={open}
        onOpenChange={setOpen}
        controls={controls}
        documentCount={documentCount}
      />
    </>
  )
}
