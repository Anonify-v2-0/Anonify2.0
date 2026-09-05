"use client"

import Link from "next/link"
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Code,
  Download,
  Layers,
} from "lucide-react"

import { BatchDownloadButton } from "@/components/batch/batch-download-button"
import { Brand } from "@/components/layout/brand"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/processing/status-pill"
import { RetentionControl } from "@/components/documents/retention-control"
import { REPOSITORY_URL } from "@/lib/config"
import { useAppDispatch } from "@/store/hooks"
import { documentLoaded } from "@/store/documentSlice"
import { exportDialogToggled } from "@/store/uiSlice"
import type { DocumentSummary } from "@/types/document"

/**
 * Moving through a batch, and back to it.
 *
 * The count of carried decisions is here rather than buried in the inspector
 * because it is the answer to "why is this already redacted?" — a question a
 * reviewer asks the moment they open the second document in a batch.
 *
 * The chip is a link back to the batch and stays at every width. The step
 * arrows are the part that folds away on a narrow screen: they are a
 * convenience, whereas losing the only route back to the batch page stranded
 * the reviewer in a document that plainly belongs to something.
 */
function BatchNav({ batch }: { batch: NonNullable<DocumentSummary["batch"]> }) {
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
    <div className="flex shrink-0 items-center gap-1">
      <span className="hidden md:flex">
        {step(batch.previousId, "previous")}
      </span>
      <Link
        href={`/batches/${batch.batchId}`}
        title="Back to this batch"
        className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs whitespace-nowrap text-text-secondary transition-colors hover:border-border-strong hover:text-white sm:px-3"
      >
        <Layers className="size-3.5 text-primary" />
        <span className="hidden sm:inline">Batch</span>
        <span className="text-text-muted">
          {batch.position}
          <span className="hidden sm:inline"> of </span>
          <span className="sm:hidden">/</span>
          {batch.total}
        </span>
        {batch.carriedRules > 0 ? (
          <span className="hidden text-text-muted lg:inline">
            · {batch.carriedRules} carried
          </span>
        ) : null}
      </Link>
      <span className="hidden md:flex">{step(batch.nextId, "next")}</span>
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

      {/*
        The reviewer is trusting this tool with their file, so the workspace is
        where a "where does this come from?" link earns its place — a subtle
        affordance, not a full footer in the editor chrome.
      */}
      <a
        href={REPOSITORY_URL}
        target="_blank"
        rel="noreferrer"
        title="View source on GitHub"
        className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:border-border-strong hover:text-white lg:flex"
      >
        <Code className="size-3.5" />
        Source
      </a>

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

      {/*
        The batch archive, offered where the reviewer finishes the last
        document rather than only on the batch page. Getting all of them was
        otherwise a navigation away from the thing you had just completed.
      */}
      {summary.batch ? (
        <BatchDownloadButton
          batchId={summary.batch.batchId}
          documentCount={summary.batch.total}
          variant="outline"
          size="default"
          className="h-9"
          label="Batch"
          // The label folds away on a narrow header, but not while the run is
          // reporting itself: a bare spinner is what it replaced.
          labelClassName="hidden lg:inline"
        />
      ) : null}

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
