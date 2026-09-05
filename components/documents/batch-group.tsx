"use client"

import { useState } from "react"
import Link from "next/link"
import { ChevronDown, Layers } from "lucide-react"

import { BatchDownloadButton } from "@/components/batch/batch-download-button"
import { DocumentCard } from "@/components/documents/document-card"
import { Button, buttonVariants } from "@/components/ui/button"
import type { DocumentListItem } from "@/lib/documents/listing"
import { cn } from "@/lib/utils"

/**
 * The documents of one upload, kept together.
 *
 * They were uploaded as one pass and are reviewed as one, so a list that
 * interleaves them with unrelated files makes the reviewer reconstruct the
 * grouping from filenames. The group says what the batch is, offers the one
 * archive at the end, and still shows each document as itself — a batch does
 * not couple them, and one failing is still one failing.
 */

const IN_PROGRESS = new Set([
  "uploading",
  "queued",
  "extracting",
  "normalizing",
  "analyzing",
  "rendering",
])

export function BatchGroup({
  batchId,
  documents,
  onDelete,
  onRetry,
  onExtended,
  deletingId,
  retryingId,
}: {
  batchId: string
  documents: DocumentListItem[]
  onDelete: (id: string) => void
  onRetry: (id: string) => void
  onExtended: (id: string, expiresAt: string) => void
  deletingId: string | null
  retryingId: string | null
}) {
  const [expanded, setExpanded] = useState(true)

  const ready = documents.filter(
    (document) => document.status === "ready"
  ).length
  const working = documents.filter((document) =>
    IN_PROGRESS.has(document.status)
  ).length
  const failed = documents.filter(
    (document) => document.status === "failed"
  ).length

  return (
    <li className="rounded-[12px] border border-border bg-surface-2/40">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse this batch" : "Expand this batch"}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown
            className={cn(
              "size-4 transition-transform",
              expanded ? "" : "-rotate-90"
            )}
          />
        </Button>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium text-white">
            <Layers className="size-3.5 text-primary" />
            Batch of {documents.length}
          </p>
          <p className="mt-0.5 text-[11px] text-text-muted">
            {ready} ready
            {working > 0 ? ` · ${working} still processing` : ""}
            {failed > 0 ? ` · ${failed} failed` : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={`/batches/${batchId}`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Open batch
          </Link>
          <BatchDownloadButton
            batchId={batchId}
            documentCount={documents.length}
            readyCount={ready}
          />
        </div>
      </div>

      {expanded ? (
        <ul className="flex flex-col gap-2 border-t border-border p-2">
          {documents.map((document) => (
            <DocumentCard
              key={document.id}
              document={document}
              onDelete={onDelete}
              onRetry={onRetry}
              onExtended={onExtended}
              deleting={deletingId === document.id}
              retrying={retryingId === document.id}
              // The batch is the container this card is already inside.
              showBatchLink={false}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
