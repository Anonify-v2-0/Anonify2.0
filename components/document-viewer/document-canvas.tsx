"use client"

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"
import { FileWarning } from "lucide-react"

import { DocxViewer } from "@/components/document-viewer/docx-viewer"
import { EmlViewer } from "@/components/document-viewer/eml-viewer"
import { PdfViewer } from "@/components/document-viewer/pdf-viewer"
import { TextViewer } from "@/components/document-viewer/text-viewer"
import { ImageCanvas } from "@/components/image-editor/image-canvas"
import { RedactionLayer } from "@/components/redaction/redaction-layer"
import { SpreadsheetGrid } from "@/components/spreadsheet/spreadsheet-grid"
import { useNormalizedDocument } from "@/hooks/use-normalized-document"
import { fitModeChanged, zoomChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { redactionSelected } from "@/store/redactionSlice"
import { selectRedactions } from "@/store/selectors"
import { cn } from "@/lib/utils"
import type { BoundingBox, DocumentSummary } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/** Horizontal breathing room kept around the page when fitting to width. */
const CANVAS_PADDING = 64

/** True when a redaction's offsets cover the run identified by `spanId`. */
function coversSpan(
  redaction: Redaction,
  page: { spans: { id: string; start: number; end: number }[] },
  spanId: string
): boolean {
  if (redaction.start === undefined || redaction.end === undefined) return false
  const span = page.spans.find((candidate) => candidate.id === spanId)
  if (!span) return false
  return span.start < redaction.end && span.end > redaction.start
}

export type CanvasActions = {
  create: (input: Omit<Redaction, "id" | "documentId">) => void
}

export function DocumentCanvas({
  summary,
  actions,
}: {
  summary: DocumentSummary
  actions?: CanvasActions
}) {
  const dispatch = useAppDispatch()
  const containerRef = useRef<HTMLDivElement>(null)
  const normalized = useNormalizedDocument(summary)
  const { currentPage, zoom, fitMode, tool } = useAppSelector(
    (state) => state.editor
  )
  const redactions = useAppSelector(selectRedactions)
  const selectedId = useAppSelector((state) => state.redactions.selectedId)

  const page =
    normalized?.pages.find((candidate) => candidate.number === currentPage) ??
    normalized?.pages[0]

  const pageRedactions = useMemo(
    () =>
      redactions.filter(
        (redaction) =>
          (redaction.page ?? 1) === (page?.number ?? 1) &&
          redaction.status !== "rejected"
      ),
    [page?.number, redactions]
  )

  const createRegion = useCallback(
    (boundingBox: BoundingBox) => {
      actions?.create({
        type: "region",
        source: "user",
        category: "other",
        status: "accepted",
        page: page?.number ?? 1,
        boundingBox,
      })
    },
    [actions, page?.number]
  )

  const redactSpan = useCallback(
    (span: { start: number; end: number; text: string }) => {
      actions?.create({
        type: "text",
        source: "user",
        category: "other",
        status: "accepted",
        page: page?.number ?? 1,
        text: span.text,
        start: span.start,
        end: span.end,
      })
    },
    [actions, page?.number]
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
        redactions={pageRedactions}
        regions={normalized.regions ?? []}
        selectedId={selectedId}
        onSelect={(redactionId) => dispatch(redactionSelected(redactionId))}
        onCreateRegion={createRegion}
        onRedactWord={redactSpan}
      />
    ) : (
      <section className="flex min-w-0 flex-1 items-center justify-center bg-surface-1">
        <Placeholder summary={summary} />
      </section>
    )
  }

  // Grids bring their own scrolling surface and ignore page zoom. A CSV and a
  // TSV normalize to the same worksheet model a workbook does, so they are
  // reviewed in the same grid rather than as text that happens to have commas.
  if (
    summary.kind === "xlsx" ||
    summary.kind === "csv" ||
    summary.kind === "tsv"
  ) {
    return normalized ? (
      <SpreadsheetGrid normalized={normalized} actions={actions} />
    ) : (
      <section className="flex min-w-0 flex-1 items-center justify-center bg-surface-1">
        <Placeholder summary={summary} />
      </section>
    )
  }

  /**
   * Drawing one span, wherever the page came from.
   *
   * A DOCX run and a line of a text file are the same thing to a reviewer: a
   * piece of the document you can point at and remove. Two copies of this
   * would be two places for the highlight, the accepted state and the keyboard
   * affordance to drift apart.
   */
  const renderSpan = (spanId: string, children: ReactNode) => {
    if (!page) return children

    const covering = pageRedactions.find((redaction) =>
      coversSpan(redaction, page, spanId)
    )
    const span = page.spans.find((candidate) => candidate.id === spanId)

    const redactThisSpan = () => {
      if (covering) {
        dispatch(redactionSelected(covering.id))
      } else if (span) {
        redactSpan({ start: span.start, end: span.end, text: span.text })
      }
    }

    return (
      <span
        key={spanId}
        role="button"
        tabIndex={0}
        title={covering ? covering.category : "Redact this text"}
        onClick={redactThisSpan}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          if (!covering) redactThisSpan()
        }}
        className={cn(
          "cursor-pointer rounded-[2px] transition-colors",
          covering?.status === "accepted"
            ? "bg-black text-black selection:bg-black"
            : covering
              ? "bg-red-soft outline-1 outline-dashed outline-red-border"
              : "hover:bg-primary/15",
          covering?.id === selectedId && "outline-1 outline-primary"
        )}
      >
        {children}
      </span>
    )
  }

  const layer = page ? (
    <RedactionLayer
      page={page}
      redactions={pageRedactions}
      selectedId={selectedId}
      zoom={zoom}
      tool={tool}
      onSelect={(id) => dispatch(redactionSelected(id))}
      onCreateRegion={createRegion}
      onRedactSpan={redactSpan}
    />
  ) : null

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
        >
          {layer}
        </PdfViewer>
      ) : summary.kind === "docx" && page ? (
        <DocxViewer page={page} zoom={zoom} renderSpan={renderSpan} />
      ) : summary.kind === "eml" && page ? (
        // A message is a flat stream *and*, where it carried an HTML body, a
        // document with headings and tables. Its viewer draws both, which the
        // fixed-width one cannot.
        <EmlViewer page={page} zoom={zoom} renderSpan={renderSpan} />
      ) : (summary.kind === "txt" ||
          summary.kind === "rtf" ||
          summary.kind === "pptx") &&
        page ? (
        <TextViewer page={page} zoom={zoom} renderSpan={renderSpan} />
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
          ? "This document could not be rendered."
          : summary.status === "failed"
            ? // Never "Preparing…" for a run that has already ended: the banner
              // above says what happened, and this must not contradict it.
              "This document could not be rendered."
            : "Preparing this document…"}
      </p>
    </div>
  )
}
