"use client"

import Link from "next/link"
import {
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Layers,
  Loader2,
  RotateCcw,
  Trash2,
} from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { StatusPill } from "@/components/processing/status-pill"
import { RetentionControl } from "@/components/documents/retention-control"
import { isRetryable } from "@/lib/workflows/failure"
import { cn } from "@/lib/utils"
import type { DocumentListItem } from "@/lib/documents/listing"
import type { DocumentKind } from "@/types/document"

/**
 * One document in the session list.
 *
 * The two things a reviewer needs at a glance are how far along the review is
 * and how long is left before the document disappears, so both are on the card
 * rather than a click away.
 */

const KIND_ICONS: Record<DocumentKind, typeof FileText> = {
  pdf: FileText,
  docx: FileText,
  xlsx: FileSpreadsheet,
  image: ImageIcon,
}

const IN_PROGRESS = new Set([
  "uploading",
  "queued",
  "extracting",
  "normalizing",
  "analyzing",
  "rendering",
])

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatCreated(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function DocumentCard({
  document,
  onDelete,
  onRetry,
  onExtended,
  deleting,
  retrying,
}: {
  document: DocumentListItem
  onDelete: (id: string) => void
  onRetry: (id: string) => void
  onExtended: (id: string, expiresAt: string) => void
  deleting: boolean
  retrying: boolean
}) {
  const Icon = KIND_ICONS[document.kind] ?? FileText
  const working = IN_PROGRESS.has(document.status)
  const reviewed = document.counts.total - document.counts.suggested
  const progress =
    document.counts.total === 0
      ? 0
      : Math.round((reviewed / document.counts.total) * 100)

  return (
    <li
      className={cn(
        "panel flex flex-col gap-4 p-4 transition-colors sm:flex-row sm:items-center sm:gap-5",
        deleting ? "opacity-50" : "hover:border-border-strong"
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-3">
          <Icon className="size-4 text-primary" />
        </span>

        <div className="min-w-0 flex-1">
          <Link
            href={`/workspace/${document.id}`}
            className="block truncate text-sm font-medium text-white transition-colors hover:text-primary"
            title={document.originalName}
          >
            {document.originalName}
          </Link>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
            <span className="tracking-wide uppercase">{document.kind}</span>
            <span>{formatSize(document.size)}</span>
            {document.pageCount ? (
              <span>
                {document.pageCount}{" "}
                {document.pageCount === 1 ? "page" : "pages"}
              </span>
            ) : null}
            <span>{formatCreated(document.createdAt)}</span>
            {document.batchId ? (
              // The batch is where the decisions carried across these documents
              // live, and from the list it is otherwise invisible.
              <Link
                href={`/batches/${document.batchId}`}
                className="inline-flex items-center gap-1 transition-colors hover:text-white"
              >
                <Layers className="size-3" />
                Batch
              </Link>
            ) : null}
          </div>

          {document.status === "failed" ? (
            <p className="mt-1.5 text-[11px] text-primary">
              {document.error?.trim()
                ? document.error
                : "Analysis failed."}{" "}
              <span className="text-text-muted">
                Your file is safe and was not modified.
              </span>
            </p>
          ) : document.counts.total > 0 ? (
            <div className="mt-2 flex items-center gap-2">
              <span
                className="h-1 w-24 overflow-hidden rounded-full bg-surface-3"
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Review progress"
              >
                <span
                  className="block h-full bg-primary transition-[width] duration-300"
                  style={{ width: `${progress}%` }}
                />
              </span>
              <span className="text-[11px] text-text-muted">
                {document.counts.suggested > 0
                  ? `${document.counts.suggested} left to review`
                  : `${document.counts.accepted} accepted`}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
        <RetentionControl
          documentId={document.id}
          createdAt={document.createdAt}
          expiresAt={document.expiresAt}
          onExtended={(expiresAt) => onExtended(document.id, expiresAt)}
        />
        <StatusPill status={document.status} />

        {/*
          A link that looks like a button, not a button that navigates. Base UI's
          Button assumes it renders a real <button> and, told otherwise, swaps
          `type="button"` for `role="button"` — which would announce the one
          control on this card that actually goes somewhere as a button, losing
          the link semantics a screen reader and a middle-click both rely on.
          Styling the link directly keeps them.
        */}
        {/*
          Retry is offered only where it could change the outcome. A file this
          instance cannot read does not become readable on the second attempt,
          and the button would spend a rate-limit token to say so again.
        */}
        {document.status === "failed" && isRetryable(document.errorCode) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={retrying}
            onClick={() => onRetry(document.id)}
          >
            {retrying ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            Retry
          </Button>
        ) : null}

        <Link
          href={`/workspace/${document.id}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          {working ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {working ? "View progress" : "Open"}
        </Link>

        <Button
          size="icon-sm"
          variant="ghost"
          disabled={deleting}
          aria-label={`Delete ${document.originalName}`}
          onClick={() => onDelete(document.id)}
        >
          {deleting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </Button>
      </div>
    </li>
  )
}
