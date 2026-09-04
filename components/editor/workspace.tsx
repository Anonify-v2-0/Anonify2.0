"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useRouter } from "next/navigation"

import { DocumentCanvas } from "@/components/document-viewer/document-canvas"
import { EditorToolbar } from "@/components/editor/editor-toolbar"
import { LiveAnnouncer } from "@/components/editor/live-announcer"
import { PageNavigator } from "@/components/editor/page-navigator"
import { WorkspaceHeader } from "@/components/editor/workspace-header"
import { ProcessingScreen } from "@/components/processing/processing-screen"
import { ExportDialog } from "@/components/redaction/export-dialog"
import { MobileInspector } from "@/components/redaction/mobile-inspector"
import { RedactionInspector } from "@/components/redaction/redaction-inspector"
import { useProcessingStream } from "@/hooks/use-processing-stream"
import { useRedactions } from "@/hooks/use-redactions"
import { useShortcuts } from "@/hooks/use-shortcuts"
import { documentLoaded } from "@/store/documentSlice"
import { pageChanged, toolChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectSelectedRedaction } from "@/store/selectors"
import type { DocumentSummary } from "@/types/document"

export function Workspace({ summary }: { summary: DocumentSummary }) {
  const dispatch = useAppDispatch()
  const router = useRouter()
  const stored = useAppSelector((state) => state.document.summary)
  const current = stored?.id === summary.id ? stored : summary
  const selected = useAppSelector(selectSelectedRedaction)
  const currentPage = useAppSelector((state) => state.editor.currentPage)

  useEffect(() => {
    dispatch(documentLoaded(summary))
  }, [dispatch, summary])

  useProcessingStream(summary.id, summary.status)

  const { accept, reject, create, applyGlobalRule, undo, redo } = useRedactions(
    summary.id,
    current.status
  )

  // The stream reports the status change; the server component holds the rest
  // of the record (page count, checksum), so refresh once when it finishes.
  const refreshed = useRef(false)
  useEffect(() => {
    if (refreshed.current) return
    if (current.status === "ready" && summary.status !== "ready") {
      refreshed.current = true
      router.refresh()
    }
  }, [current.status, router, summary.status])

  const pageCount = current.pageCount ?? 1

  const shortcuts = useMemo(
    () => ({
      onRedactTool: () => dispatch(toolChanged("redact")),
      onSelectTool: () => dispatch(toolChanged("select")),
      onAccept: () => selected && accept([selected.id]),
      onReject: () => selected && reject([selected.id]),
      onToggle: () => {
        if (!selected) return
        if (selected.status === "accepted") reject([selected.id])
        else accept([selected.id])
      },
      onUndo: undo,
      onRedo: redo,
      onNextPage: () =>
        dispatch(pageChanged(Math.min(pageCount, currentPage + 1))),
      onPreviousPage: () => dispatch(pageChanged(Math.max(1, currentPage - 1))),
    }),
    [accept, currentPage, dispatch, pageCount, redo, reject, selected, undo]
  )

  useShortcuts(shortcuts, current.status === "ready")

  const canvasActions = useMemo(
    () => ({ create: (input: Parameters<typeof create>[0]) => void create(input) }),
    [create]
  )

  const inspectorActions = useMemo(
    () => ({
      accept: (ids: string[]) => void accept(ids),
      reject: (ids: string[]) => void reject(ids),
      applyGlobalRule: (pattern: string, category: string) =>
        void applyGlobalRule(pattern, category),
    }),
    [accept, applyGlobalRule, reject]
  )

  const onExport = useCallback(() => undefined, [])

  const ready = current.status === "ready"
  const failed = current.status === "failed"

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <WorkspaceHeader summary={current} />

      {ready || failed ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <PageNavigator documentId={summary.id} />
            <DocumentCanvas summary={current} actions={canvasActions} />
            <RedactionInspector actions={inspectorActions} />
          </div>
          <MobileInspector actions={inspectorActions} />
          <EditorToolbar onUndo={undo} onRedo={redo} onExport={onExport} />
        </div>
      ) : (
        <ProcessingScreen summary={current} />
      )}

      <ExportDialog summary={current} />
      <LiveAnnouncer />
    </div>
  )
}
