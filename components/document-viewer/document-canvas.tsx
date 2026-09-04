"use client"

import { useEffect, useMemo, useRef } from "react"
import { FileWarning } from "lucide-react"

import { DocxViewer } from "@/components/document-viewer/docx-viewer"
import { PdfViewer } from "@/components/document-viewer/pdf-viewer"
import { ImageCanvas } from "@/components/image-editor/image-canvas"
import { SpreadsheetGrid } from "@/components/spreadsheet/spreadsheet-grid"
import { useNormalizedDocument } from "@/hooks/use-normalized-document"
import { randomClientId } from "@/lib/documents/client-ids"
import { fitModeChanged, zoomChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { redactionAdded, redactionSelected } from "@/store/redactionSlice"
import type { DocumentSummary } from "@/types/document"

/** Horizontal breathing room kept around the page when fitting to width. */
const CANVAS_PADDING = 64

export function DocumentCanvas({ summary }: { summary: DocumentSummary }) {
  const dispatch = useAppDispatch()
  const containerRef = useRef<HTMLDivElement>(null)
  const normalized = useNormalizedDocument(summary.id, summary.status)
  const { currentPage, zoom, fitMode } = useAppSelector((state) => state.editor)
  const redactionEntities = useAppSelector((state) => state.redactions.entities)
  const selectedId = useAppSelector((state) => state.redactions.selectedId)
  const redactions = useMemo(
    () => Object.values(redactionEntities),
    [redactionEntities]
  )

  const page =
    normalized?.pages.find((candidate) => candidate.number === currentPage) ??
    normalized?.pages[0]

  const acceptedRegions = redactions
    .filter(
      (redaction) =>
        redaction.status === "accepted" && redaction.boundingBox !== undefined
    )
    .map((redaction) => redaction.boundingBox!)

  const suggestedRegions = (normalized?.regions ?? []).filter(
    (region) =>
      !acceptedRegions.some(
        (box) =>
          box.x === region.boundingBox.x && box.y === region.boundingBox.y
      )
  )

  // Fit-to-width/page recomputes on resize; explicit zooming switches the mode
  // to "custom" so the user's choice is not overwritten.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !page || fitMode === "custom") return
    const mode: "width" | "page" = fitMode

    function apply() {
      if (!container || !page) return
      const available = container.clientWidth - CANVAS_PADDING
      const scale =
        mode === "page"
          ? Math.min(
              available / page.width,
              (container.clientHeight - CANVAS_PADDING) / page.height
            )
          : available / page.width

      if (Number.isFinite(scale) && scale > 0) {
        dispatch(zoomChanged(Number(scale.toFixed(3))))
        // zoomChanged flips the mode to "custom"; restore the fit the user chose.
        dispatch(fitModeChanged(mode))
      }
    }

    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(container)
    return () => observer.disconnect()
  }, [dispatch, fitMode, page])

  if (summary.kind === "image") {
    return normalized ? (
      <ImageCanvas
        documentId={summary.id}
        normalized={normalized}
        zoom={zoom}
        accepted={acceptedRegions}
        suggested={suggestedRegions}
        selectedRegionId={selectedId}
        onSelectRegion={(regionId) => dispatch(redactionSelected(regionId))}
        onCreateRegion={(boundingBox) =>
          dispatch(
            redactionAdded({
              id: randomClientId("red"),
              documentId: summary.id,
              type: "region",
              source: "user",
              category: "other",
              status: "accepted",
              page: 1,
              boundingBox,
            })
          )
        }
      />
    ) : (
      <section className="flex min-w-0 flex-1 items-center justify-center bg-surface-1">
        <Placeholder summary={summary} />
      </section>
    )
  }

  // Workbooks bring their own scrolling surface and ignore page zoom.
  if (summary.kind === "xlsx") {
    return normalized ? (
      <SpreadsheetGrid normalized={normalized} />
    ) : (
      <section className="flex min-w-0 flex-1 items-center justify-center bg-surface-1">
        <Placeholder summary={summary} />
      </section>
    )
  }

  return (
    <section
      ref={containerRef}
      className="flex min-w-0 flex-1 justify-center overflow-auto bg-surface-1 p-8"
    >
      {summary.kind === "pdf" && page ? (
        <PdfViewer
          documentId={summary.id}
          page={page}
          pageNumber={page.number}
          zoom={zoom}
        />
      ) : summary.kind === "docx" && page ? (
        <DocxViewer page={page} zoom={zoom} />
      ) : (
        <Placeholder summary={summary} />
      )}
    </section>
  )
}

function Placeholder({ summary }: { summary: DocumentSummary }) {
  return (
    <div className="flex aspect-[1/1.294] w-full max-w-[640px] flex-col items-center justify-center gap-3 self-center rounded-[4px] bg-document text-center shadow-document">
      <FileWarning className="size-6 text-neutral-400" />
      <p className="text-sm font-medium text-document-foreground">
        {summary.originalName}
      </p>
      <p className="max-w-xs text-xs text-neutral-500">
        {summary.status === "ready"
          ? `Rendering for ${summary.kind.toUpperCase()} documents arrives with its format pipeline.`
          : "Preparing this document…"}
      </p>
    </div>
  )
}
