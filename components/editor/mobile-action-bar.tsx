"use client"

import { useState, type ReactNode } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  Download,
  Keyboard,
  ListChecks,
  Maximize2,
  MoreHorizontal,
  MoveHorizontal,
  Redo2,
  Scale,
  Search,
  Sparkles,
  SquareDashed,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react"

import { RetentionControl } from "@/components/documents/retention-control"
import { Sheet } from "@/components/ui/sheet"
import { useLearnedShapes } from "@/hooks/use-learned-shapes"
import { useMediaQuery } from "@/hooks/use-media-query"
import { FINE_HOVER } from "@/lib/editor/layout"
import { cn } from "@/lib/utils"
import { documentLoaded } from "@/store/documentSlice"
import {
  fitModeChanged,
  MAX_ZOOM,
  MIN_ZOOM,
  toolChanged,
  zoomChanged,
  zoomStepped,
} from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import {
  batchSearchToggled,
  resultsToggled,
  searchClosed,
  searchOpened,
} from "@/store/searchSlice"
import { selectCanRedo, selectCanUndo, selectCounts } from "@/store/selectors"
import {
  assistantToggled,
  exportDialogToggled,
  inspectorTabChanged,
  mobileSheetToggled,
  shortcutsToggled,
} from "@/store/uiSlice"
import type { DocumentSummary } from "@/types/document"

/**
 * The phone's toolbar: one row at the bottom, within thumb reach, replacing
 * the desktop toolbar and the floating review button.
 *
 *   Redact · Search · Review · Hush · More
 *
 * Every control carries a visible label, because the desktop toolbar's
 * labels live in hover tooltips that never appear on a touch screen, and
 * every target is at least 44 px square. Zoom, undo and redo, rules, export,
 * retention and (where there is a keyboard) the shortcut sheet are in More.
 *
 * Shown by the `compact` variant (a phone, or a touch tablet in portrait),
 * so it is right on first paint, before any script has run.
 */
export function MobileActionBar({
  summary,
  onUndo,
  onRedo,
}: {
  summary: DocumentSummary
  onUndo: () => void
  onRedo: () => void
}) {
  const dispatch = useAppDispatch()
  const tool = useAppSelector((state) => state.editor.tool)
  const searchOpen = useAppSelector((state) => state.search.open)
  const hushOpen = useAppSelector((state) => state.ui.assistant !== null)
  const reviewOpen = useAppSelector((state) => state.ui.mobileSheetOpen)
  const counts = useAppSelector(selectCounts)
  const learned = useLearnedShapes().length
  const [moreOpen, setMoreOpen] = useState(false)

  const drawing = tool === "redact"

  /**
   * One panel at a time on a phone: the sheets rest in the same place, and a
   * second one opened over the first hid it without closing it.
   */
  const closePanels = () => {
    dispatch(mobileSheetToggled(false))
    dispatch(assistantToggled(null))
    dispatch(resultsToggled(false))
    dispatch(batchSearchToggled(false))
  }

  return (
    <>
      <nav
        aria-label="Review tools"
        className="hidden shrink-0 border-t border-border bg-surface-2 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] compact:flex"
      >
        <BarButton
          label="Redact"
          pressed={drawing}
          onClick={() => dispatch(toolChanged(drawing ? "select" : "redact"))}
          hint={drawing ? "Drag on the page to draw a box" : undefined}
        >
          <SquareDashed className="size-5" />
        </BarButton>
        <BarButton
          label="Search"
          pressed={searchOpen}
          onClick={() => {
            if (!searchOpen) closePanels()
            dispatch(searchOpen ? searchClosed() : searchOpened())
          }}
        >
          <Search className="size-5" />
        </BarButton>
        <BarButton
          label="Review"
          pressed={reviewOpen}
          haspopup
          onClick={() => {
            if (!reviewOpen) closePanels()
            dispatch(inspectorTabChanged("redactions"))
            dispatch(mobileSheetToggled(!reviewOpen))
          }}
          badge={counts.suggested > 0 ? counts.suggested : undefined}
          description={
            counts.suggested > 0
              ? `${counts.suggested} to review`
              : `${counts.total} redactions`
          }
        >
          <ListChecks className="size-5" />
        </BarButton>
        <BarButton
          label="Hush"
          pressed={hushOpen}
          haspopup
          onClick={() => {
            if (!hushOpen) closePanels()
            dispatch(assistantToggled())
          }}
          dot={learned > 0}
          description={
            learned > 0
              ? `the review assistant, ${learned} rule ${learned === 1 ? "idea" : "ideas"}`
              : "the review assistant"
          }
        >
          <Sparkles className="size-5" />
        </BarButton>
        <BarButton
          label="More"
          pressed={moreOpen}
          haspopup
          onClick={() => setMoreOpen(true)}
        >
          <MoreHorizontal className="size-5" />
        </BarButton>
      </nav>

      <MoreSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        summary={summary}
        onUndo={onUndo}
        onRedo={onRedo}
      />
    </>
  )
}

function BarButton({
  label,
  pressed,
  haspopup,
  badge,
  dot,
  hint,
  description,
  onClick,
  children,
}: {
  label: string
  pressed: boolean
  haspopup?: boolean
  badge?: number
  dot?: boolean
  hint?: string
  description?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-haspopup={haspopup ? "dialog" : undefined}
      onClick={onClick}
      className={cn(
        "relative flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
        pressed ? "text-primary" : "text-text-secondary active:bg-white/5"
      )}
    >
      <span
        className={cn(
          "relative flex h-7 w-12 items-center justify-center rounded-full transition-colors",
          pressed && "bg-red-soft"
        )}
      >
        {children}
        {badge !== undefined ? (
          <span
            aria-hidden
            className="absolute -top-1 right-0 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
        {dot ? (
          <span
            aria-hidden
            className="absolute top-0 right-2 size-2 rounded-full bg-primary"
          />
        ) : null}
      </span>
      {label}
      {(description ?? hint) ? (
        <span className="sr-only">, {description ?? hint}</span>
      ) : null}
    </button>
  )
}

/** Everything the bar has no room for, with its label written out. */
function MoreSheet({
  open,
  onOpenChange,
  summary,
  onUndo,
  onRedo,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  summary: DocumentSummary
  onUndo: () => void
  onRedo: () => void
}) {
  const dispatch = useAppDispatch()
  const { zoom, fitMode } = useAppSelector((state) => state.editor)
  const canUndo = useAppSelector(selectCanUndo)
  const canRedo = useAppSelector(selectCanRedo)
  const ruleCount = useAppSelector((state) => state.rules.items.length)
  // Shortcuts are offered where there is plausibly a keyboard to use them.
  const keyboard = useMediaQuery(FINE_HOVER)
  const close = () => onOpenChange(false)

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="More"
      snaps={["half", "full"]}
      modal
      className="roomy:hidden"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        <Group title="History">
          <Action label="Undo" disabled={!canUndo} onClick={onUndo}>
            <Undo2 className="size-4" />
          </Action>
          <Action label="Redo" disabled={!canRedo} onClick={onRedo}>
            <Redo2 className="size-4" />
          </Action>
        </Group>

        <Group title="Document">
          <Action
            label={ruleCount > 0 ? `Rules (${ruleCount})` : "Rules"}
            onClick={() => {
              close()
              dispatch(inspectorTabChanged("rules"))
              dispatch(mobileSheetToggled(true))
            }}
          >
            <ListChecks className="size-4" />
          </Action>
          <Action
            label="Export"
            disabled={summary.status !== "ready"}
            onClick={() => {
              close()
              dispatch(exportDialogToggled(true))
            }}
          >
            <Download className="size-4" />
          </Action>
          {keyboard ? (
            <Action
              label="Keyboard shortcuts"
              onClick={() => {
                close()
                dispatch(shortcutsToggled(true))
              }}
            >
              <Keyboard className="size-4" />
            </Action>
          ) : null}
          <Link
            href="/documents"
            className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm text-text-secondary transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ArrowLeft className="size-4" />
            All documents
          </Link>
        </Group>

        <Group title="Zoom">
          <Action
            label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => dispatch(zoomStepped(-0.1))}
          >
            <ZoomOut className="size-4" />
          </Action>
          <Action
            label={`${Math.round(zoom * 100)}%, actual size`}
            onClick={() => dispatch(zoomChanged(1))}
          >
            <Scale className="size-4" />
          </Action>
          <Action
            label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => dispatch(zoomStepped(0.1))}
          >
            <ZoomIn className="size-4" />
          </Action>
          <Action
            label="Fit width"
            pressed={fitMode === "width"}
            onClick={() => dispatch(fitModeChanged("width"))}
          >
            <MoveHorizontal className="size-4" />
          </Action>
          <Action
            label="Fit page"
            pressed={fitMode === "page"}
            onClick={() => dispatch(fitModeChanged("page"))}
          >
            <Maximize2 className="size-4" />
          </Action>
        </Group>

        <Group title="Keep this document">
          <RetentionControl
            documentId={summary.id}
            createdAt={summary.createdAt}
            expiresAt={summary.expiresAt}
            onExtended={(expiresAt) =>
              dispatch(documentLoaded({ ...summary, expiresAt }))
            }
            className="min-h-11 border border-border"
          />
        </Group>
      </div>
    </Sheet>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pt-4">
      <h3 className="label-micro pb-2">{title}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  )
}

function Action({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40",
        pressed
          ? "border-red-border bg-red-soft text-primary"
          : "border-border text-text-secondary hover:text-white"
      )}
    >
      {children}
      {label}
    </button>
  )
}
