"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import { FileWarning } from "lucide-react"

import { DocxViewer } from "@/components/document-viewer/docx-viewer"
import { EmlViewer } from "@/components/document-viewer/eml-viewer"
import { PdfViewer } from "@/components/document-viewer/pdf-viewer"
import { TextViewer } from "@/components/document-viewer/text-viewer"
import { ImageCanvas } from "@/components/image-editor/image-canvas"
import { RedactionLayer } from "@/components/redaction/redaction-layer"
import {
  caretAt,
  pageOffsetOf,
  SearchBoxes,
  useTextHighlights,
} from "@/components/search/search-highlights"
import { wordAt } from "@/lib/redaction/words"
import { SpreadsheetGrid } from "@/components/spreadsheet/spreadsheet-grid"
import {
  useNormalizedDocument,
  useNormalizedPage,
  usePrefetchPages,
} from "@/hooks/use-normalized-document"
import { fitModeChanged, zoomChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { redactionSelected } from "@/store/redactionSlice"
import { selectRedactions } from "@/store/selectors"
import type { BoundingBox, DocumentSummary } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/** Horizontal breathing room kept around the page when fitting to width. */
const CANVAS_PADDING = 64

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
  /** Set for the click that ends a text selection; see `onSelectionEnd`. */
  const justSelected = useRef(false)
  const normalized = useNormalizedDocument(summary)
  const { currentPage, zoom, fitMode, tool } = useAppSelector(
    (state) => state.editor
  )
  const redactions = useAppSelector(selectRedactions)
  const selectedId = useAppSelector((state) => state.redactions.selectedId)

  // The page on the canvas, fetched on its own; the rest of the document is
  // not held. Its neighbours are asked for early so paging does not wait.
  const pageNumbers = normalized?.pageNumbers
  const pageNumber = pageNumbers?.includes(currentPage)
    ? currentPage
    : pageNumbers?.[0]
  const page = useNormalizedPage(summary.id, pageNumber) ?? undefined
  usePrefetchPages(summary.id, [
    pageNumber === undefined ? undefined : pageNumber - 1,
    pageNumber === undefined ? undefined : pageNumber + 1,
  ])

  const pageRedactions = useMemo(
    () =>
      redactions.filter(
        (redaction) =>
          (redaction.page ?? 1) === (page?.number ?? 1) &&
          redaction.status !== "rejected"
      ),
    [page?.number, redactions]
  )

  // A new page opens at its top. Declared before the painter below, whose
  // scroll to a hit or a focused place has to win when it has somewhere to go:
  // layout effects run in the order they are declared.
  const shownPage = page?.number
  useLayoutEffect(() => {
    containerRef.current?.scrollTo({ top: 0 })
  }, [shownPage])

  // Text drawn as text is painted by exact characters: hits, redactions and
  // a focused place. PDF and image draw theirs as boxes.
  const textFlow = summary.kind !== "pdf" && summary.kind !== "image"
  useTextHighlights(containerRef, page, textFlow, pageRedactions, selectedId)

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
        page={page}
        zoom={zoom}
        redactions={pageRedactions}
        regions={normalized.regions ?? []}
        selectedId={selectedId}
        onSelect={(redactionId) => dispatch(redactionSelected(redactionId))}
        onCreateRegion={createRegion}
        onRedactWord={redactSpan}
        overlay={page ? <SearchBoxes page={page} /> : null}
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
  /**
   * Redacting by pointing, in text drawn as text.
   *
   * A click redacts the value under the pointer — the token around the
   * character clicked, see `wordAt` — and a click inside an existing
   * redaction selects it. Selecting text with the mouse redacts exactly the
   * selection, across lines if need be. Neither redacts the span: a span is a
   * whole line of a text file, and redacting it to remove the one ID on it was
   * the most common way to over-redact a document.
   */
  const redactionAt = (offset: number) =>
    pageRedactions.find(
      (redaction) =>
        redaction.start !== undefined &&
        redaction.end !== undefined &&
        redaction.start <= offset &&
        offset < redaction.end
    )

  const redactRange = (start: number, end: number) => {
    if (!page) return
    // Whitespace at either end of a selection is never the point.
    while (start < end && /\s/.test(page.text[start])) start += 1
    while (end > start && /\s/.test(page.text[end - 1])) end -= 1
    if (end <= start) return
    redactSpan({ start, end, text: page.text.slice(start, end) })
  }

  const onSelectionEnd = () => {
    const root = containerRef.current
    const selection = window.getSelection()
    if (!root || !page || !selection || selection.isCollapsed) return
    if (!selection.anchorNode || !selection.focusNode) return
    if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return
    const from = pageOffsetOf(root, page, selection.anchorNode, selection.anchorOffset)
    const to = pageOffsetOf(root, page, selection.focusNode, selection.focusOffset)
    if (from === null || to === null || from === to) return
    redactRange(Math.min(from, to), Math.max(from, to))
    selection.removeAllRanges()
    // The click that ends a drag must not also redact the word under it.
    justSelected.current = true
    setTimeout(() => (justSelected.current = false), 0)
  }

  const renderSpan = (spanId: string, children: ReactNode) => {
    if (!page) return children

    const span = page.spans.find((candidate) => candidate.id === spanId)

    const onPoint = (x: number, y: number) => {
      if (justSelected.current) return
      const root = containerRef.current
      const caret = caretAt(x, y)
      const offset =
        root && caret ? pageOffsetOf(root, page, caret.node, caret.offset) : null
      if (offset === null) return

      const existing = redactionAt(offset)
      if (existing) {
        dispatch(redactionSelected(existing.id))
        return
      }
      const word = wordAt(page.text, offset)
      if (word) redactRange(word.start, word.end)
    }

    return (
      <span
        key={spanId}
        role="button"
        tabIndex={0}
        title="Click a value to redact it, or select text to redact exactly that"
        onClick={(event) => onPoint(event.clientX, event.clientY)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          // From the keyboard there is no pointer to aim with: the span is the
          // unit, unless something in it is already redacted, which selects.
          if (!span) return
          const existing = pageRedactions.find(
            (redaction) =>
              redaction.start !== undefined &&
              redaction.end !== undefined &&
              redaction.start < span.end &&
              redaction.end > span.start
          )
          if (existing) dispatch(redactionSelected(existing.id))
          else redactRange(span.start, span.end)
        }}
        // What a redaction covers is painted by its characters (see
        // useTextHighlights), not by the span it falls in: a span is a whole
        // line in some formats, and styling it marked the line.
        className="cursor-pointer rounded-[2px] focus-visible:outline-1 focus-visible:outline-primary"
      >
        {children}
      </span>
    )
  }

  const layer = page ? (
    <>
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
      <SearchBoxes page={page} />
    </>
  ) : null

  return (
    <section
      ref={containerRef}
      onMouseUp={textFlow ? onSelectionEnd : undefined}
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
        <EmlViewer
          page={page}
          zoom={zoom}
          renderSpan={renderSpan}
          redactions={pageRedactions}
        />
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
