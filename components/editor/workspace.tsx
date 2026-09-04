"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"

import { DocumentCanvas } from "@/components/document-viewer/document-canvas"
import { EditorToolbar } from "@/components/editor/editor-toolbar"
import { PageNavigator } from "@/components/editor/page-navigator"
import { WorkspaceHeader } from "@/components/editor/workspace-header"
import { ProcessingScreen } from "@/components/processing/processing-screen"
import { RedactionInspector } from "@/components/redaction/redaction-inspector"
import { useProcessingStream } from "@/hooks/use-processing-stream"
import { documentLoaded } from "@/store/documentSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import type { DocumentSummary } from "@/types/document"

export function Workspace({ summary }: { summary: DocumentSummary }) {
  const dispatch = useAppDispatch()
  const router = useRouter()
  const stored = useAppSelector((state) => state.document.summary)
  const current = stored?.id === summary.id ? stored : summary

  useEffect(() => {
    dispatch(documentLoaded(summary))
  }, [dispatch, summary])

  useProcessingStream(summary.id, summary.status)

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
