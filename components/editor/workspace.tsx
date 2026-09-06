"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useRouter } from "next/navigation"

import { DocumentCanvas } from "@/components/document-viewer/document-canvas"
import { EditorToolbar } from "@/components/editor/editor-toolbar"
import { LiveAnnouncer } from "@/components/editor/live-announcer"
import { PageNavigator } from "@/components/editor/page-navigator"
import { WorkspaceHeader } from "@/components/editor/workspace-header"
import { FailureNotice } from "@/components/processing/failure-notice"
import { ProcessingScreen } from "@/components/processing/processing-screen"
import { ExportDialog } from "@/components/redaction/export-dialog"
import { MobileInspector } from "@/components/redaction/mobile-inspector"
import { RedactionInspector } from "@/components/redaction/redaction-inspector"
import { useProcessingStream } from "@/hooks/use-processing-stream"
import { useRedactions, type RuleScope } from "@/hooks/use-redactions"
import { useShortcuts } from "@/hooks/use-shortcuts"
import { documentLoaded, documentStatusChanged } from "@/store/documentSlice"
import { pageChanged, toolChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectSelectedRedaction } from "@/store/selectors"
import { isReviewable, type DocumentSummary } from "@/types/document"
import type { RedactionMethod } from "@/types/redaction"

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

  const { accept, reject, setMethod, create, applyGlobalRule, undo, redo } =
    useRedactions(summary.id, isReviewable(current))

  /**
   * The stream reports the status change; the server component holds the rest of
   * the record — page count, checksum, and whether there is a normalized model
   * to open — so refresh when the run reaches a terminal state.
   *
   * Failure is refreshed for as well as success. A run that dies after
   * extraction leaves a document the editor can still open, and only the server
   * render knows that.
   *
   * The guard remembers which status it refreshed for rather than whether it has
   * refreshed at all, so a retry that fails a second time still updates.
   */
  const refreshedFor = useRef<string | null>(null)
  useEffect(() => {
    const settled =
      current.status === "ready" ||
      current.status === "expanded" ||
      current.status === "failed"
    if (!settled) return
    if (current.status === summary.status) return
    if (refreshedFor.current === current.status) return

    refreshedFor.current = current.status
    router.refresh()
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

  useShortcuts(shortcuts, isReviewable(current))

  const canvasActions = useMemo(
    () => ({ create: (input: Parameters<typeof create>[0]) => void create(input) }),
    [create]
  )

  const inspectorActions = useMemo(
    () => ({
      accept: (ids: string[]) => void accept(ids),
      reject: (ids: string[]) => void reject(ids),
      setMethod: (ids: string[], method: RedactionMethod) =>
        void setMethod(ids, method),
      applyGlobalRule: (pattern: string, category: string, scope?: RuleScope) =>
        void applyGlobalRule(pattern, category, scope),
    }),
    [accept, applyGlobalRule, reject, setMethod]
  )

  const onExport = useCallback(() => undefined, [])

  const failed = current.status === "failed"

  /**
   * A failed document is only worth opening in the editor if extraction got far
   * enough to leave something behind.
   *
   * This branch used to read `ready || failed`, which sent every failure to the
   * editor — so the failure screen, the reason and the retry button were all
   * unreachable here, and a document that had died minutes ago sat under
   * "Preparing this document…" as though it were still working. A failure that
   * reads as a hang is the worst of both: no explanation, and no reason to stop
   * waiting.
   *
   * Past extraction there is a normalized model, so manual redaction is real
   * and the editor is the right thing to show — with a banner saying analysis
   * did not finish, because an empty suggestion list must never be mistaken for
   * a clean document.
   */
  const reviewable = isReviewable(current)

  const onRetried = useCallback(() => {
    // Moving the status locally is what reconnects the processing stream, which
    // only subscribes while a document is still working. Clearing the guard lets
    // the next terminal status refresh again, including a second failure.
    refreshedFor.current = null
    dispatch(documentStatusChanged("queued"))
    router.refresh()
  }, [dispatch, router])

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <WorkspaceHeader summary={current} />

      {reviewable ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {failed ? (
            <FailureNotice
              summary={current}
              variant="banner"
              onRetried={onRetried}
            />
          ) : null}
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
