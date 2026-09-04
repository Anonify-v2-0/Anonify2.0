"use client"

import { useEffect } from "react"

import { DocumentCanvas } from "@/components/document-viewer/document-canvas"
import { EditorToolbar } from "@/components/editor/editor-toolbar"
import { PageNavigator } from "@/components/editor/page-navigator"
import { WorkspaceHeader } from "@/components/editor/workspace-header"
import { ProcessingScreen } from "@/components/processing/processing-screen"
import { RedactionInspector } from "@/components/redaction/redaction-inspector"
import { useDocumentStatus } from "@/hooks/use-document-status"
import { documentLoaded } from "@/store/documentSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import type { DocumentSummary } from "@/types/document"

export function Workspace({ summary }: { summary: DocumentSummary }) {
  const dispatch = useAppDispatch()
  const current = useAppSelector((state) => state.document.summary) ?? summary

  useEffect(() => {
    dispatch(documentLoaded(summary))
  }, [dispatch, summary])

  useDocumentStatus(summary.id, summary.status)

  const ready = current.status === "ready"
  const failed = current.status === "failed"

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <WorkspaceHeader summary={current} />

      {ready || failed ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <PageNavigator />
            <DocumentCanvas summary={current} />
            <RedactionInspector />
          </div>
          <EditorToolbar />
        </div>
      ) : (
        <ProcessingScreen summary={current} />
      )}
    </div>
  )
}
