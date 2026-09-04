"use client"

import Link from "next/link"
import { ArrowLeft, Download } from "lucide-react"

import { Brand } from "@/components/layout/brand"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/processing/status-pill"
import { RetentionControl } from "@/components/documents/retention-control"
import { useAppDispatch } from "@/store/hooks"
import { documentLoaded } from "@/store/documentSlice"
import { exportDialogToggled } from "@/store/uiSlice"
import type { DocumentSummary } from "@/types/document"

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
        <p className="text-[11px] text-text-muted uppercase">{summary.kind}</p>
      </div>

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
