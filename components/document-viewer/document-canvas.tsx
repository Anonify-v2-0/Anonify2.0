"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
  coarseRedactionClass,
  pageOffsetOf,
  SearchBoxes,
  useHighlightsSupported,
  useTextHighlights,
} from "@/components/search/search-highlights"
import { wordAt } from "@/lib/redaction/words"
import { SpreadsheetGrid } from "@/components/spreadsheet/spreadsheet-grid"
import {
  useNormalizedDocument,
  useNormalizedPage,
  usePrefetchPages,
} from "@/hooks/use-normalized-document"
import { usePinchZoom } from "@/hooks/use-pinch-zoom"
import { fitModeChanged, zoomChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { redactionSelected } from "@/store/redactionSlice"
import { inspectorTabChanged, mobileSheetToggled } from "@/store/uiSlice"
import { selectRedactions } from "@/store/selectors"
import { cn } from "@/lib/utils"
import type { BoundingBox, DocumentSummary } from "@/types/document"
import type { Redaction } from "@/types/redaction"

export type CanvasActions = {
  create: (input: Omit<Redaction, "id" | "documentId">) => void
  accept?: (ids: string[]) => void
  reject?: (ids: string[]) => void
  remove?: (id: string) => void
  /** A drawn region moved or resized; see `adjustBox`. */
  adjust?: (id: string, box: BoundingBox) => void
}

/** The breathing room around the page: whatever padding the canvas has now. */
function paddingOf(element: HTMLElement): { x: number; y: number } {
  const style = getComputedStyle(element)
  return {
    x: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
    y: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
  }
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
  const paintsCharacters = useHighlightsSupported()

  usePinchZoom(containerRef, zoom)

  /**
   * How the last press on the canvas was made. A mouse selection redacts on
   * release, as it always has. A touch selection does not: on a phone it is
   * a long-press and then handles adjusted in several steps, and there is no
   * moment that means "done" — so it offers a "Redact selection" button
   * instead, and nothing is redacted until that is pressed.
   */
  const lastPointer = useRef<string>("mouse")
  const [pendingSelection, setPendingSelection] = useState<{
    start: number
    end: number
    rect: { left: number; top: number; bottom: number; width: number }
  } | null>(null)
  const pressingAction = useRef(false)

  useEffect(() => {
    if (!textFlow || !page) return
    let clearTimer: ReturnType<typeof setTimeout> | undefined
    function onSelectionChange() {
      if (lastPointer.current === "mouse") return
      const root = containerRef.current
      const selection = window.getSelection()
      const inside =
        root &&
        selection &&
        !selection.isCollapsed &&
        selection.anchorNode &&
        selection.focusNode &&
        root.contains(selection.anchorNode) &&
        root.contains(selection.focusNode)
      if (!inside || !page) {
        // Tapping the button collapses the selection before its click
        // arrives on some phones; keep the offer long enough to be taken.
        clearTimeout(clearTimer)
        clearTimer = setTimeout(() => {
          if (!pressingAction.current) setPendingSelection(null)
        }, 400)
        return
      }
      clearTimeout(clearTimer)
      const from = pageOffsetOf(root, page, selection.anchorNode!, selection.anchorOffset)
      const to = pageOffsetOf(root, page, selection.focusNode!, selection.focusOffset)
      if (from === null || to === null || from === to) return
      const bounds = selection.getRangeAt(0).getBoundingClientRect()
      setPendingSelection({
        start: Math.min(from, to),
        end: Math.max(from, to),
        rect: {
          left: bounds.left,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
        },
      })
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      clearTimeout(clearTimer)
      document.removeEventListener("selectionchange", onSelectionChange)
    }
  }, [page, textFlow])

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
      // Read from the element, not a constant: the padding is smaller on a
      // phone, where 64 px of a 390 px screen was a sixth of the page.
      const padding = paddingOf(container)
      const available = container.clientWidth - padding.x
      const scale =
        mode === "page"
          ? Math.min(
              available / page.width,
              (container.clientHeight - padding.y) / page.height
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

  /** What a tap on a redaction can do without the inspector; see RedactionPopover. */
  const redactionActions = useMemo(
    () => ({
      accept: (id: string) => actions?.accept?.([id]),
      reject: (id: string) => actions?.reject?.([id]),
      remove: (id: string) => actions?.remove?.(id),
      adjust: (id: string, box: BoundingBox) => actions?.adjust?.(id, box),
      inspect: (id: string) => {
        dispatch(redactionSelected(id))
        dispatch(inspectorTabChanged("redactions"))
        dispatch(mobileSheetToggled(true))
      },
    }),
    [actions, dispatch]
  )

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
        tool={tool}
        actions={redactionActions}
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
    if (lastPointer.current !== "mouse") return
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
        // line in some formats, and styling it marked the line. Only a
        // browser that cannot paint characters gets the span styled.
        className={cn(
          "cursor-pointer rounded-[2px] focus-visible:outline-1 focus-visible:outline-primary",
          !paintsCharacters &&
            coarseRedactionClass(span, pageRedactions, selectedId)
        )}
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
        actions={redactionActions}
      />
      <SearchBoxes page={page} />
    </>
  ) : null

  return (
    <section
      ref={containerRef}
      onPointerDown={(event) => {
        lastPointer.current = event.pointerType
        if (event.pointerType === "mouse") setPendingSelection(null)
      }}
      onMouseUp={textFlow ? onSelectionEnd : undefined}
      // One finger scrolls; two are the canvas's own pinch (usePinchZoom).
      style={{ touchAction: "pan-x pan-y" }}
      className="flex min-w-0 flex-1 justify-center overflow-auto bg-surface-1 p-3 pb-20 sm:p-8 sm:pb-20 lg:pb-8"
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
      {pendingSelection ? (
        <button
          type="button"
          onPointerDown={() => (pressingAction.current = true)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            pressingAction.current = false
            redactRange(pendingSelection.start, pendingSelection.end)
            window.getSelection()?.removeAllRanges()
            setPendingSelection(null)
          }}
          // Below the selection: the phone's own copy menu sits above it.
          style={{
            left: Math.min(
              Math.max(12, pendingSelection.rect.left + pendingSelection.rect.width / 2 - 80),
              window.innerWidth - 172
            ),
            top: Math.min(pendingSelection.rect.bottom + 12, window.innerHeight - 140),
          }}
          className="fixed z-30 flex h-11 w-40 items-center justify-center gap-2 rounded-full bg-primary text-sm font-medium text-primary-foreground shadow-panel"
        >
          <span aria-hidden className="h-2.5 w-3.5 rounded-[1px] bg-current" />
          Redact selection
        </button>
      ) : null}
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
