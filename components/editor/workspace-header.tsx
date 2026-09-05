"use client"

import Link from "next/link"
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Layers } from "lucide-react"

import { Brand } from "@/components/layout/brand"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/processing/status-pill"
import { RetentionControl } from "@/components/documents/retention-control"
import { useAppDispatch } from "@/store/hooks"
import { documentLoaded } from "@/store/documentSlice"
import { exportDialogToggled } from "@/store/uiSlice"
import type { DocumentSummary } from "@/types/document"

/**
 * Moving through a batch without going back to the list.
 *
 * The count of carried decisions is here rather than buried in the inspector
 * because it is the answer to "why is this already redacted?" — a question a
 * reviewer asks the moment they open the second document in a batch.
 */
function BatchNav({
  batch,
}: {
  batch: NonNullable<DocumentSummary["batch"]>
}) {
  const step = (id: string | null, direction: "previous" | "next") =>
    id ? (
      <Link
        href={`/workspace/${id}`}
        aria-label={`${direction === "next" ? "Next" : "Previous"} document in this batch`}
        className="flex size-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-white"
      >
        {direction === "next" ? (
          <ChevronRight className="size-4" />
        ) : (
          <ChevronLeft className="size-4" />
        )}
      </Link>
    ) : (
      <span className="flex size-7 items-center justify-center text-text-muted/40">
        {direction === "next" ? (
          <ChevronRight className="size-4" />
        ) : (
          <ChevronLeft className="size-4" />
        )}
      </span>
    )

  return (
    <div className="hidden items-center gap-1 md:flex">
      {step(batch.previousId, "previous")}
      <Link
        href={`/batches/${batch.batchId}`}
        className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-text-secondary transition-colors hover:text-white"
      >
        <Layers className="size-3.5" />
        {batch.position} of {batch.total}
        {batch.carriedRules > 0 ? (
          <span className="text-text-muted">
            · {batch.carriedRules} carried
          </span>
        ) : null}
      </Link>
      {step(batch.nextId, "next")}
    </div>
  )
}

export function WorkspaceHeader({ summary }: { summary: DocumentSummary }) {
  const dispatch = useAppDispatch()

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface-2 px-4 lg:h-[68px] lg:px-6">
      {/* The mark carries the brand once the wordmark no longer fits. */}
      <Brand showWordmark={false} size={26} className="sm:hidden" />
      <Brand size={26} className="hidden sm:flex" />

      <Link
        href="/documents"
        className="flex items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-white"
      >
        <ArrowLeft className="size-4" />
        <span className="hidden md:inline">Documents</span>
      </Link>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white md:text-base">
          {summary.originalName}
        </p>
        <p className="text-[11px] text-text-muted">
          <span className="uppercase">{summary.kind}</span>
          {summary.presetLabel ? (
            // Said here rather than only at upload: an empty inspector reads as
            // "nothing to redact" unless you know the search was narrowed.
            <span> · looked for {summary.presetLabel.toLowerCase()}</span>
          ) : null}
        </p>
      </div>

      {summary.batch ? <BatchNav batch={summary.batch} /> : null}

      <RetentionControl
        documentId={summary.id}
        createdAt={summary.createdAt}
        expiresAt={summary.expiresAt}
        onExtended={(expiresAt) =>
          dispatch(documentLoaded({ ...summary, expiresAt }))
        }
        className="hidden lg:inline-flex"
      />
      <StatusPill status={summary.status} />

      <Button
        className="btn-pill h-9"
        disabled={summary.status !== "ready"}
        onClick={() => dispatch(exportDialogToggled(true))}
      >
        <Download className="size-4" />
        <span className="hidden sm:inline">Export</span>
      </Button>
    </header>
  )
}
