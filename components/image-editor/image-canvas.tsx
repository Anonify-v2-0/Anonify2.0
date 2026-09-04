"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { boxesForRedaction, padBox } from "@/lib/redaction/geometry"
import { cn } from "@/lib/utils"
import type {
  BoundingBox,
  ImageRegion,
  NormalizedDocument,
} from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * The image editor.
 *
 * An image carries its text twice: as pixels, and — once OCR has read it — as a
 * page of normalized text with a box behind every word. Detection runs over
 * that text exactly as it does for a PDF, so its proposals arrive here as
 * ordinary text redactions carrying offsets rather than geometry, and they are
 * placed with the same `boxesForRedaction` the exporter uses. Sharing that
 * function is the point: what is drawn here is a promise about what the
 * downloaded file will look like.
 *
 * OCR words are hit targets, not proposals. Clicking one redacts it, and a
 * hand-drawn rectangle snaps to one when it lands close — detection assists the
 * user rather than deciding for them.
 */

/** A drag whose corners land within this many px of a region snaps to it. */
const SNAP_TOLERANCE = 12
/** Anything smaller than this is a stray click, not a redaction. */
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

function snap(box: BoundingBox, regions: ImageRegion[]): BoundingBox {
  let best: { region: ImageRegion; distance: number } | null = null

  for (const region of regions) {
    const target = region.boundingBox
    const distance =
      Math.abs(target.x - box.x) +
      Math.abs(target.y - box.y) +
      Math.abs(target.x + target.width - (box.x + box.width)) +
      Math.abs(target.y + target.height - (box.y + box.height))

    if (distance <= SNAP_TOLERANCE * 4 && (!best || distance < best.distance)) {
      best = { region, distance }
    }
  }

  return best ? { ...best.region.boundingBox } : box
}

/** What a redaction covers, for its label and its accessible name. */
function describe(redaction: Redaction): string {
  if (redaction.type === "face") return "Face"
  return redaction.text || redaction.category
}

export type ImageCanvasProps = {
  documentId: string
  normalized: NormalizedDocument
  zoom: number
  /** Every redaction on the image, accepted or still proposed. */
  redactions: Redaction[]
  /** OCR words: snap targets and one-click redaction, never proposals. */
  regions: ImageRegion[]
  selectedId?: string | null
  onSelect?: (redactionId: string) => void
  onCreateRegion?: (box: BoundingBox) => void
  /** Redacts one OCR word by its offsets, the way selecting text does. */
  onRedactWord?: (span: { start: number; end: number; text: string }) => void
}

export function ImageCanvas({
  documentId,
  normalized,
  zoom,
  redactions,
  regions,
  selectedId,
  onSelect,
  onCreateRegion,
  onRedactWord,
}: ImageCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const page = normalized.pages[0]

  // A text redaction carries offsets, not a rectangle. Resolving it through the
  // OCR span geometry is what makes a detection over scanned text visible on
  // the pixels it was found in; without this the suggestion exists in the
  // inspector and nowhere on the image.
  const placed = useMemo(() => {
    if (!page) return []
    return redactions.flatMap((redaction) => {
      const boxes = boxesForRedaction(page, redaction)
      return boxes.length > 0 ? [{ redaction, boxes }] : []
    })
  }, [page, redactions])

  const toImageSpace = useCallback(
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

  // The drag continues even when the pointer leaves the image.
  useEffect(() => {
    if (!draft) return

    function onMove(event: PointerEvent) {
      const point = toImageSpace(event)
      setDraft((current) =>
        current ? { ...current, x: point.x, y: point.y } : current
      )
    }

    function onUp() {
      setDraft((current) => {
        if (!current) return null
        const box = draftToBox(current)
        if (box.width >= MIN_DRAG_PX && box.height >= MIN_DRAG_PX) {
          onCreateRegion?.(snap(box, regions))
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
  }, [draft, onCreateRegion, regions, toImageSpace])

  if (!page) return null

  const draftBox = draft ? draftToBox(draft) : null
  const spans = new Map(page.spans.map((span) => [span.id, span]))

  return (
    <section className="flex min-w-0 flex-1 items-start justify-center overflow-auto bg-surface-1 p-8">
      <div
        ref={surfaceRef}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          const point = toImageSpace(event)
          setDraft({ startX: point.x, startY: point.y, ...point })
        }}
        className="relative touch-none shadow-document select-none"
        style={{ width: page.width * zoom, height: page.height * zoom }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- authorized, no-store source stream */}
        <img
          src={`/api/documents/${documentId}/source`}
          alt=""
          draggable={false}
          className="block h-full w-full bg-document object-contain"
        />

        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: page.width,
            height: page.height,
            transform: `scale(${zoom})`,
          }}
        >
          {/* OCR words, transparent until hovered. Drawing a dashed box around
              every word read as a hundred proposals, and none of them were.
              Out of the tab order for the same reason the PDF word targets
              are: a scan as hundreds of tab stops is worse than none, and the
              inspector already reaches every redaction from the keyboard. */}
          {regions.map((region) => {
            const span = spans.get(region.id)
            if (!span) return null

            return (
              <button
                key={region.id}
                type="button"
                tabIndex={-1}
                aria-hidden
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() =>
                  onRedactWord?.({
                    start: span.start,
                    end: span.end,
                    text: span.text,
                  })
                }
                title={region.text ? `Redact "${region.text}"` : "Redact"}
                className="absolute rounded-[1px] border border-transparent transition-colors hover:border-red-border hover:bg-primary/20"
                style={{
                  left: region.boundingBox.x,
                  top: region.boundingBox.y,
                  width: region.boundingBox.width,
                  height: region.boundingBox.height,
                }}
              />
            )
          })}

          {placed.map(({ redaction, boxes }) =>
            boxes.map((raw, index) => {
              const box = padBox(raw)
              const accepted = redaction.status === "accepted"
              const selected = selectedId === redaction.id

              return (
                <button
                  key={`${redaction.id}-${index}`}
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onSelect?.(redaction.id)}
                  aria-pressed={accepted}
                  aria-label={`${accepted ? "Redacted" : "Suggested"}: ${describe(redaction)}`}
                  className={cn(
                    "absolute transition-colors",
                    accepted
                      ? "bg-black"
                      : "border border-dashed bg-red-soft hover:bg-primary/20",
                    !accepted &&
                      (selected ? "border-primary bg-primary/25" : "border-red-border"),
                    selected && accepted && "outline-2 outline-primary"
                  )}
                  style={{
                    left: box.x,
                    top: box.y,
                    width: box.width,
                    height: box.height,
                  }}
                >
                  {/* One label per redaction, not per box: a value spanning two
                      OCR words would otherwise be captioned twice. */}
                  {!accepted && index === 0 ? (
                    <span className="absolute -top-4 left-0 text-[9px] font-medium tracking-wide text-primary uppercase">
                      {redaction.type === "face" ? "Face" : redaction.category}
                      {redaction.confidence
                        ? ` ${Math.round(redaction.confidence * 100)}%`
                        : ""}
                    </span>
                  ) : null}
                </button>
              )
            })
          )}

          {draftBox ? (
            <div
              className="absolute border border-primary bg-primary/20"
              style={{
                left: draftBox.x,
                top: draftBox.y,
                width: draftBox.width,
                height: draftBox.height,
              }}
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}
