"use client"

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import {
  RedactionPopover,
  RegionHandles,
  TapFlash,
  useRegionEditor,
  type RedactionLayerActions,
} from "@/components/redaction/touch-overlays"
import { usePinchZoom } from "@/hooks/use-pinch-zoom"
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
import { boxesForRedaction, padBox } from "@/lib/redaction/geometry"
import { cn } from "@/lib/utils"
import type {
  BoundingBox,
  ImageRegion,
  NormalizedPage,
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
 *
 * Touch follows the same rules as the PDF layer (see redaction-layer.tsx and
 * draw-gesture.ts): one finger scrolls and pinches zoom unless the redact tool
 * is in hand. The surface used to be `touch-none` in every tool, which made
 * drawing work and left a phone unable to scroll past an image that filled
 * its screen.
 */

/** A drag whose corners land within this many px of a region snaps to it. */
const SNAP_TOLERANCE = 12
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
  /** The image's one page of OCR text, once it has arrived. */
  page: NormalizedPage | undefined
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
  /** Drawn in image units above everything else: search hits. */
  overlay?: ReactNode
  tool?: "select" | "redact" | "pan"
  actions?: RedactionLayerActions
}

export function ImageCanvas({
  documentId,
  page,
  zoom,
  redactions,
  regions,
  selectedId,
  onSelect,
  onCreateRegion,
  onRedactWord,
  overlay,
  tool = "select",
  actions,
}: ImageCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const [draw, setDraw] = useState<DrawState>(IDLE)
  const drawRef = useRef<DrawState>(IDLE)
  const lastPointer = useRef("mouse")
  const justDrew = useRef(false)
  const anchors = useRef(new Map<string, HTMLElement>())
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const [flash, setFlash] = useState<{ key: number; boxes: BoundingBox[] } | null>(null)
  const regionEditor = useRegionEditor({
    bounds: { width: page?.width ?? 0, height: page?.height ?? 0 },
    commit: actions?.adjust
      ? (id, box) => actions.adjust(id, snap(box, regions))
      : undefined,
  })
  // Memoized by the compiler; the popover resubscribes if it changes.
  const closeMenu = () => setMenu(null)

  usePinchZoom(sectionRef, zoom)

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

  const send = (event: DrawEvent) => {
    const { state, commit } = drawReducer(drawRef.current, event)
    if (state === drawRef.current) return
    drawRef.current = state
    setDraw(state)
    if (commit) {
      justDrew.current = true
      setTimeout(() => (justDrew.current = false), 0)
      onCreateRegion?.(snap(commit, regions))
    }
  }

  const redactWord = (span: { start: number; end: number; text: string }, box: BoundingBox) => {
    onRedactWord?.(span)
    if (lastPointer.current !== "mouse") {
      setFlash((previous) => ({ key: (previous?.key ?? 0) + 1, boxes: [box] }))
    }
  }

  if (!page) return null

  const draft = draftBox(draw)
  const spans = new Map(page.spans.map((span) => [span.id, span]))
  const selected = placed.find(({ redaction }) => redaction.id === selectedId)?.redaction
  const selectedBox = selected ? regionEditor.boxOf(selected) : undefined
  const menuRedaction = menu
    ? redactions.find((candidate) => candidate.id === menu.id)
    : undefined

  return (
    <section
      ref={sectionRef}
      style={{ touchAction: "pan-x pan-y" }}
      className="flex min-w-0 flex-1 items-start justify-center overflow-auto bg-surface-1 p-3 sm:p-8"
    >
      <div
        ref={surfaceRef}
        data-zoom-surface
        onPointerDown={(event) => {
          lastPointer.current = event.pointerType
          send({
            type: "down",
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            button: event.button,
            // A mouse draws on an image in any tool, as it always has.
            tool: event.pointerType === "mouse" && tool === "select" ? "redact" : tool,
            point: toImageSpace(event),
          })
          if (drawRef.current.kind === "drafting") {
            // Not the browser's image drag or text selection.
            event.preventDefault()
            event.currentTarget.setPointerCapture?.(event.pointerId)
          }
        }}
        onPointerMove={(event) =>
          drawRef.current.kind === "drafting" &&
          send({ type: "move", pointerId: event.pointerId, point: toImageSpace(event) })
        }
        onPointerUp={(event) => send({ type: "up", pointerId: event.pointerId })}
        onPointerCancel={(event) => send({ type: "cancel", pointerId: event.pointerId })}
        onLostPointerCapture={(event) => send({ type: "cancel", pointerId: event.pointerId })}
        onClick={(event) => {
          // A tap between OCR words: the nearest one within a finger's reach.
          if (justDrew.current || lastPointer.current === "mouse") return
          if ((event.target as HTMLElement).closest("button")) return
          const point = toImageSpace(event)
          const reach = MIN_TOUCH_TARGET / 2 / zoom
          // Redactions and words compete on distance; see redaction-layer.tsx.
          const shown = placed.flatMap(({ redaction, boxes }) =>
            boxes.map((raw) => ({ redaction, box: regionEditor.boxOf(redaction) ?? padBox(raw) }))
          )
          const index = nearestBox(
            point,
            [...shown.map((entry) => entry.box), ...regions.map((region) => region.boundingBox)],
            reach
          )
          if (index === null) return
          if (index < shown.length) {
            const { redaction } = shown[index]
            onSelect?.(redaction.id)
            const anchor = anchors.current.get(redaction.id)
            if (anchor && actions) setMenu({ id: redaction.id, anchor })
            return
          }
          const region = regions[index - shown.length]
          const span = spans.get(region.id)
          if (!span) return
          redactWord({ start: span.start, end: span.end, text: span.text }, region.boundingBox)
        }}
        className="relative shadow-document select-none"
        style={{
          width: page.width * zoom,
          height: page.height * zoom,
          touchAction: surfaceTouchAction(tool),
        }}
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
            ["--hit-size" as string]: `${MIN_TOUCH_TARGET / zoom}px`,
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
                onPointerDown={(event) => {
                  lastPointer.current = event.pointerType
                  // In the redact tool a finger may start a box on a word.
                  if (tool !== "redact" || event.pointerType === "mouse") {
                    event.stopPropagation()
                  }
                }}
                onClick={() =>
                  redactWord(
                    { start: span.start, end: span.end, text: span.text },
                    region.boundingBox
                  )
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
              const own = regionEditor.boxOf(redaction)
              const box = own ? own : padBox(raw)
              const accepted = redaction.status === "accepted"
              const selected = selectedId === redaction.id

              return (
                <button
                  key={`${redaction.id}-${index}`}
                  ref={(element) => {
                    if (index !== 0) return
                    if (element) anchors.current.set(redaction.id, element)
                    else anchors.current.delete(redaction.id)
                  }}
                  type="button"
                  onPointerDown={(event) => {
                    lastPointer.current = event.pointerType
                    event.stopPropagation()
                  }}
                  onClick={(event) => {
                    onSelect?.(redaction.id)
                    if (lastPointer.current !== "mouse" && actions) {
                      setMenu({ id: redaction.id, anchor: event.currentTarget })
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!selected) return
                    if (!event.key.startsWith("Arrow")) return
                    if (regionEditor.nudge(redaction, event.key, event.shiftKey)) {
                      event.preventDefault()
                      event.stopPropagation()
                    }
                  }}
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

          {overlay}

          {selected && selectedBox && actions ? (
            <RegionHandles
              box={selectedBox}
              zoom={zoom}
              bounds={{ width: page.width, height: page.height }}
              onPreview={(box) =>
                regionEditor.setPreview(box ? { id: selected.id, box } : null)
              }
              onCommit={(box) =>
                regionEditor.finish(selected.id, box, selected.boundingBox!)
              }
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
        </div>
      </div>
      {menu && menuRedaction && actions ? (
        <RedactionPopover
          redaction={menuRedaction}
          anchor={menu.anchor}
          actions={actions}
          onClose={closeMenu}
        />
      ) : null}
    </section>
  )
}
