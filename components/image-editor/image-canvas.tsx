"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import type { BoundingBox, ImageRegion, NormalizedDocument } from "@/types/document"

/**
 * The image editor.
 *
 * Detected OCR words and faces are offered as ready-made regions, and dragging
 * anywhere creates one by hand — detection assists the user rather than
 * deciding for them. A new rectangle snaps to a detected region when it lands
 * close to one, which makes covering a line of text a single gesture.
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

export type ImageCanvasProps = {
  documentId: string
  normalized: NormalizedDocument
  zoom: number
  /** Regions the user has already accepted, drawn as opaque redactions. */
  accepted: BoundingBox[]
  /** Regions proposed by detection, drawn as dashed suggestions. */
  suggested: ImageRegion[]
  selectedRegionId?: string | null
  onSelectRegion?: (regionId: string) => void
  onCreateRegion?: (box: BoundingBox) => void
}

export function ImageCanvas({
  documentId,
  normalized,
  zoom,
  accepted,
  suggested,
  selectedRegionId,
  onSelectRegion,
  onCreateRegion,
}: ImageCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const page = normalized.pages[0]

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
          onCreateRegion?.(snap(box, suggested))
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
  }, [draft, onCreateRegion, suggested, toImageSpace])

  if (!page) return null

  const draftBox = draft ? draftToBox(draft) : null

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
          {suggested.map((region) => (
            <button
              key={region.id}
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onSelectRegion?.(region.id)}
              title={region.text ?? region.kind}
              className={cn(
                "absolute border border-dashed bg-red-soft transition-colors",
                selectedRegionId === region.id
                  ? "border-primary bg-primary/25"
                  : "border-red-border hover:bg-primary/20"
              )}
              style={{
                left: region.boundingBox.x,
                top: region.boundingBox.y,
                width: region.boundingBox.width,
                height: region.boundingBox.height,
              }}
            >
              {region.kind === "face" ? (
                <span className="absolute -top-4 left-0 text-[9px] font-medium tracking-wide text-primary uppercase">
                  Face
                  {region.confidence
                    ? ` ${Math.round(region.confidence * 100)}%`
                    : ""}
                </span>
              ) : null}
            </button>
          ))}

          {accepted.map((box, index) => (
            <div
              key={`accepted-${index}`}
              className="absolute bg-black"
              style={{
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
              }}
            />
          ))}

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
