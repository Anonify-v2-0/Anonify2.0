"use client"

import { useCallback, useEffect, useRef, useState } from "react"

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
 */

const MIN_DRAG_PX = 6

type Draft = { startX: number; startY: number; x: number; y: number }

function draftToBox(draft: Draft): BoundingBox {
  return {
    x: Math.min(draft.startX, draft.x),
    y: Math.min(draft.startY, draft.y),
    width: Math.abs(draft.x - draft.startX),
    height: Math.abs(draft.y - draft.startY),
  }
}

/** The boxes a text redaction covers, derived from the page's span geometry. */
export function boxesForRedaction(
  page: NormalizedPage,
  redaction: Redaction
): BoundingBox[] {
  if (redaction.boundingBox) return [redaction.boundingBox]
  if (redaction.start === undefined || redaction.end === undefined) return []

  const boxes: BoundingBox[] = []
  for (const span of page.spans) {
    if (!span.boundingBox) continue
    if (span.end <= redaction.start || span.start >= redaction.end) continue

    const from = Math.max(span.start, redaction.start) - span.start
    const to = Math.min(span.end, redaction.end) - span.start
    const unit = span.boundingBox.width / Math.max(1, span.text.length)

    boxes.push({
      x: span.boundingBox.x + unit * from,
      y: span.boundingBox.y,
      width: Math.max(unit * (to - from), unit),
      height: span.boundingBox.height,
    })
  }
  return boxes
}

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
        while every word remains one click from being redacted.
      */}
      {page.spans.map((span) =>
        span.boundingBox ? (
          <button
            key={span.id}
            type="button"
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
              title={`${redaction.category}${
                redaction.confidence
                  ? ` · ${Math.round(redaction.confidence * 100)}%`
                  : ""
              }`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onSelect(redaction.id)}
              className={cn(
                "absolute transition-colors",
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
