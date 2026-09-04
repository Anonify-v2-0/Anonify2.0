"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { boxesForRedaction } from "@/lib/redaction/geometry"
import { cn } from "@/lib/utils"
import type { BoundingBox, NormalizedPage } from "@/types/document"
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

const MIN_DRAG_PX = 6

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

type Draft = { startX: number; startY: number; x: number; y: number }

function draftToBox(draft: Draft): BoundingBox {
  return {
    x: Math.min(draft.startX, draft.x),
    y: Math.min(draft.startY, draft.y),
    width: Math.abs(draft.x - draft.startX),
    height: Math.abs(draft.y - draft.startY),
  }
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
}: RedactionLayerProps) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)

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

  // The drag continues even when the pointer leaves the page.
  useEffect(() => {
    if (!draft) return

    function onMove(event: PointerEvent) {
      const point = toPageSpace(event)
      setDraft((current) => (current ? { ...current, ...point } : current))
    }

    function onUp() {
      setDraft((current) => {
        if (!current) return null
        const box = draftToBox(current)
        if (box.width >= MIN_DRAG_PX && box.height >= MIN_DRAG_PX) {
          onCreateRegion(box)
        }
        return null
      })
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [draft, onCreateRegion, toPageSpace])

  const draftBox = draft ? draftToBox(draft) : null

  return (
    <div
      ref={surfaceRef}
      className={cn("absolute inset-0", tool === "redact" && "cursor-crosshair")}
      onPointerDown={(event) => {
        if (event.button !== 0 || tool === "pan") return
        const point = toPageSpace(event)
        setDraft({ startX: point.x, startY: point.y, ...point })
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
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() =>
              onRedactSpan({ start: span.start, end: span.end, text: span.text })
            }
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

      {redactions.map((redaction) =>
        boxesForRedaction(page, redaction).map((box, index) => {
          const accepted = redaction.status === "accepted"
          const selected = redaction.id === selectedId

          return (
            <button
              key={`${redaction.id}-${index}`}
              type="button"
              aria-pressed={accepted}
              aria-label={describe(redaction)}
              title={describe(redaction)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onSelect(redaction.id)}
              className={cn(
                "absolute transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                accepted
                  ? "bg-black"
                  : "border border-dashed border-red-border bg-red-soft hover:bg-primary/25",
                selected && !accepted && "border-primary bg-primary/30",
                selected && accepted && "outline-2 outline-offset-1 outline-primary"
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
      )}

      {draftBox ? (
        <div
          className="pointer-events-none absolute border border-primary bg-primary/20"
          style={{
            left: draftBox.x,
            top: draftBox.y,
            width: draftBox.width,
            height: draftBox.height,
          }}
        />
      ) : null}
    </div>
  )
}
