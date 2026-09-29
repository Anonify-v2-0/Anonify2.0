"use client"

import { useCallback, useRef, useState } from "react"

import {
  RedactionPopover,
  RegionHandles,
  TapFlash,
  useRegionEditor,
  type RedactionLayerActions,
} from "@/components/redaction/touch-overlays"
import {
  draftBox,
  drawReducer,
  IDLE,
  surfaceTouchAction,
  type DrawEvent,
  type DrawState,
} from "@/lib/editor/draw-gesture"
import { MIN_TOUCH_TARGET } from "@/lib/editor/layout"
import { nearestBox } from "@/lib/editor/touch-geometry"
import { boxesForRange, boxesForRedaction } from "@/lib/redaction/geometry"
import { characterAtX, wordAt } from "@/lib/redaction/words"
import { cn } from "@/lib/utils"
import type { BoundingBox, NormalizedPage, TextSpan } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * The annotation layer over a rendered page.
 *
 * Suggestions are translucent and dashed; accepted redactions are solid black,
 * which is what the export will actually produce — the canvas shows the outcome
 * rather than a decoration standing in for it. Words are clickable and a drag
 * creates a region, so anything the detectors missed is one gesture away.
 *
 * Accessibility: the per-word hit targets are a pointer affordance and are kept
 * out of the tab order deliberately — a page of prose would otherwise be several
 * hundred tab stops, which is worse than having none. Redactions themselves are
 * focusable and toggle from the keyboard, and the inspector list is the complete
 * keyboard path to every suggestion on the page.
 */

/** A label a screen reader can act on, rather than a bare category. */
function describe(redaction: Redaction): string {
  const confidence = redaction.confidence
    ? `, ${Math.round(redaction.confidence * 100)} percent confidence`
    : ""
  const state =
    redaction.status === "accepted" ? "redacted" : "suggested, not yet accepted"
  const value = redaction.text ? `: ${redaction.text}` : ""
  return `${redaction.category}${value}${confidence}. ${state}. Press to select.`
}

// Re-exported so callers that render redactions keep importing from one place.
export { boxesForRedaction }

export type RedactionLayerProps = {
  page: NormalizedPage
  redactions: Redaction[]
  selectedId: string | null
  zoom: number
  onSelect: (id: string) => void
  onCreateRegion: (box: BoundingBox) => void
  onRedactSpan: (span: { start: number; end: number; text: string }) => void
  tool: "select" | "redact" | "pan"
  actions?: RedactionLayerActions
}

/** The character range a press at `x` (page units from the span's left) means. */
function rangeAt(page: NormalizedPage, span: TextSpan, x: number) {
  const box = span.boundingBox
  // The value under the pointer, not the run: a PDF run is often a whole
  // line, and redacting it to remove one name on it removed the line. See
  // `wordAt`.
  const character =
    span.offsets && span.offsets.length === span.text.length + 1
      ? characterAtX(span.offsets, x)
      : span.geometry === "word" || !box
        ? -1
        : Math.min(span.text.length - 1, Math.floor((x / box.width) * span.text.length))
  const word = character >= 0 ? wordAt(page.text, span.start + character) : null
  // A word from OCR is already the unit; so is a run whose characters cannot
  // be placed.
  const range = word ?? { start: span.start, end: span.end }
  return { ...range, text: page.text.slice(range.start, range.end) }
}

export function RedactionLayer({
  page,
  redactions,
  selectedId,
  zoom,
  onSelect,
  onCreateRegion,
  onRedactSpan,
  tool,
  actions,
}: RedactionLayerProps) {
  const [draw, setDraw] = useState<DrawState>(IDLE)
  const drawRef = useRef<DrawState>(IDLE)
  const surfaceRef = useRef<HTMLDivElement>(null)
  /** How the last press was made: a tap on touch means more than a click. */
  const lastPointer = useRef("mouse")
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  /** Each redaction's first box, for anchoring its menu. */
  const anchors = useRef(new Map<string, HTMLElement>())
  /** Set when a drag just made a region, so its closing click does nothing more. */
  const justDrew = useRef(false)
  const [flash, setFlash] = useState<{ key: number; boxes: BoundingBox[] } | null>(null)
  const regions = useRegionEditor({
    bounds: { width: page.width, height: page.height },
    commit: actions?.adjust,
  })

  const toPageSpace = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      return {
        x: (event.clientX - rect.left) / zoom,
        y: (event.clientY - rect.top) / zoom,
      }
    },
    [zoom]
  )

  const send = (event: DrawEvent) => {
    const { state, commit } = drawReducer(drawRef.current, event)
    if (state === drawRef.current) return
    drawRef.current = state
    setDraw(state)
    if (commit) {
      justDrew.current = true
      setTimeout(() => (justDrew.current = false), 0)
      onCreateRegion(commit)
    }
  }

  const redact = (range: { start: number; end: number; text: string }) => {
    onRedactSpan(range)
    if (lastPointer.current !== "mouse") {
      const boxes = boxesForRange(page, range.start, range.end)
      setFlash((previous) => ({ key: (previous?.key ?? 0) + 1, boxes }))
    }
  }

  const draft = draftBox(draw)
  // Memoized by the compiler; the popover resubscribes if it changes.
  const closeMenu = () => setMenu(null)
  const menuRedaction = menu ? redactions.find((candidate) => candidate.id === menu.id) : undefined
  const selected = redactions.find((candidate) => candidate.id === selectedId)
  const selectedBox = selected ? regions.boxOf(selected) : undefined

  return (
    <div
      ref={surfaceRef}
      className={cn("absolute inset-0", tool === "redact" && "cursor-crosshair")}
      style={{
        touchAction: surfaceTouchAction(tool),
        // 44 CSS px in this layer's own units, for `hit-expand`.
        ["--hit-size" as string]: `${MIN_TOUCH_TARGET / zoom}px`,
      }}
      onPointerDown={(event) => {
        lastPointer.current = event.pointerType
        send({
          type: "down",
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          button: event.button,
          tool,
          point: toPageSpace(event),
        })
        // The drag belongs to the surface that started it, wherever the
        // pointer goes, and ends there too.
        if (drawRef.current.kind === "drafting") {
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }
      }}
      onPointerMove={(event) =>
        drawRef.current.kind === "drafting" &&
        send({ type: "move", pointerId: event.pointerId, point: toPageSpace(event) })
      }
      onPointerUp={(event) => send({ type: "up", pointerId: event.pointerId })}
      // The browser took the gesture back (a scroll, a system gesture), or
      // capture was lost: the draft is discarded, never left on screen.
      onPointerCancel={(event) => send({ type: "cancel", pointerId: event.pointerId })}
      onLostPointerCapture={(event) => send({ type: "cancel", pointerId: event.pointerId })}
      onClick={(event) => {
        // A click that reached the surface rather than a word: in the redact
        // tool, one that started on a word and did not become a drag; on
        // touch, a tap that landed between words. Either takes the nearest
        // word, within a finger's reach for a finger and none for a mouse.
        if (event.target !== event.currentTarget || justDrew.current) return
        const mouse = lastPointer.current === "mouse"
        if (tool === "pan" || (mouse && tool === "select")) return
        const point = toPageSpace(event)
        const index = nearestBox(
          point,
          page.spans.map((span) => span.boundingBox),
          mouse ? 0 : MIN_TOUCH_TARGET / 2 / zoom
        )
        if (index === null) return
        const span = page.spans[index]
        const box = span.boundingBox!
        redact(rangeAt(page, span, Math.min(Math.max(point.x - box.x, 0), box.width)))
      }}
    >
      {/*
        Word boxes. Transparent until hovered, so the document reads normally
        while every word remains one click from being redacted. Hidden from
        assistive technology and from the tab order — see the note above.
      */}
      {page.spans.map((span) =>
        span.boundingBox ? (
          <button
            key={span.id}
            type="button"
            tabIndex={-1}
            aria-hidden
            title={span.text}
            onPointerDown={(event) => {
              lastPointer.current = event.pointerType
              // In the redact tool a press on a word may be the start of a
              // box: text covers most of a page, and a finger has nowhere
              // else to start one.
              if (tool !== "redact") event.stopPropagation()
            }}
            onClick={(event) => {
              const target = event.currentTarget.getBoundingClientRect()
              const box = span.boundingBox
              const x = box ? ((event.clientX - target.left) / target.width) * box.width : 0
              redact(rangeAt(page, span, x))
            }}
            className="absolute cursor-pointer bg-transparent transition-colors hover:bg-primary/20"
            style={{
              left: span.boundingBox.x,
              top: span.boundingBox.y,
              width: span.boundingBox.width,
              height: span.boundingBox.height,
            }}
          />
        ) : null
      )}

      {redactions.map((redaction) => {
        const own = regions.boxOf(redaction)
        const boxes = own ? [own] : boxesForRedaction(page, redaction)
        return boxes.map((box, index) => {
          const accepted = redaction.status === "accepted"
          const isSelected = redaction.id === selectedId

          return (
            <button
              key={`${redaction.id}-${index}`}
              ref={(element) => {
                if (index !== 0) return
                if (element) anchors.current.set(redaction.id, element)
                else anchors.current.delete(redaction.id)
              }}
              type="button"
              aria-pressed={accepted}
              aria-label={describe(redaction)}
              title={describe(redaction)}
              onPointerDown={(event) => {
                lastPointer.current = event.pointerType
                event.stopPropagation()
              }}
              onClick={(event) => {
                onSelect(redaction.id)
                if (lastPointer.current !== "mouse" && actions) {
                  setMenu({ id: redaction.id, anchor: event.currentTarget })
                }
              }}
              onKeyDown={(event) => {
                if (!isSelected || !event.key.startsWith("Arrow")) return
                if (regions.nudge(redaction, event.key, event.shiftKey)) {
                  // Arrows move the region, not the page.
                  event.preventDefault()
                  event.stopPropagation()
                }
              }}
              className={cn(
                "hit-expand absolute transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                accepted
                  ? "bg-black"
                  : "border border-dashed border-red-border bg-red-soft hover:bg-primary/25",
                isSelected && !accepted && "border-primary bg-primary/30",
                isSelected && accepted && "outline-2 outline-offset-1 outline-primary"
              )}
              style={{
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
              }}
            />
          )
        })
      })}

      {selected && selectedBox && actions ? (
        <RegionHandles
          box={selectedBox}
          zoom={zoom}
          bounds={{ width: page.width, height: page.height }}
          onPreview={(box) =>
            regions.setPreview(box ? { id: selected.id, box } : null)
          }
          onCommit={(box) => regions.finish(selected.id, box, selected.boundingBox!)}
          onTap={(event) => {
            if (event.pointerType === "mouse") return
            const anchor = anchors.current.get(selected.id)
            if (anchor) setMenu({ id: selected.id, anchor })
          }}
        />
      ) : null}

      {flash ? (
        <TapFlash key={flash.key} boxes={flash.boxes} onDone={() => setFlash(null)} />
      ) : null}

      {draft ? (
        <div
          className="pointer-events-none absolute border border-primary bg-primary/20"
          style={{
            left: draft.x,
            top: draft.y,
            width: draft.width,
            height: draft.height,
          }}
        />
      ) : null}

      {menu && menuRedaction && actions ? (
        <RedactionPopover
          redaction={menuRedaction}
          anchor={menu.anchor}
          actions={actions}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  )
}
