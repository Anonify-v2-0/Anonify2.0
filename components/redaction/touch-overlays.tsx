"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { createPortal } from "react-dom"
import { Check, Info, Trash2, Undo2, X } from "lucide-react"

import {
  adjustBox,
  nudgeBox,
  sameBox,
  type BoxHandle,
} from "@/lib/editor/touch-geometry"
import { cn } from "@/lib/utils"
import type { BoundingBox } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * What both canvases (the PDF annotation layer and the image editor) draw on
 * top of the page for fingers and for fixing regions: handles to move and
 * resize a selected region, a small menu of actions on a tapped redaction,
 * and a flash over what a tap just redacted.
 *
 * None of it paints a redaction. The black and dashed boxes are still drawn
 * by the canvas from `boxesForRedaction`, so what is on screen remains what
 * the export will cover.
 */

/** What a redaction on the canvas can be asked to do without the inspector. */
export type RedactionLayerActions = {
  accept: (id: string) => void
  reject: (id: string) => void
  remove: (id: string) => void
  adjust: (id: string, box: BoundingBox) => void
  /** Selects it and opens the inspector on it. */
  inspect: (id: string) => void
}

/**
 * A region being moved or resized, before it is saved: held here so the canvas
 * can draw it where the finger is, and saved once when the finger lifts (or,
 * from the keyboard, once the arrows stop).
 */
export function useRegionEditor({
  bounds,
  commit,
}: {
  bounds: { width: number; height: number }
  commit: ((id: string, box: BoundingBox) => void) | undefined
}) {
  const [preview, setPreview] = useState<{ id: string; box: BoundingBox } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(preview)
  useEffect(() => {
    latest.current = preview
  }, [preview])
  useEffect(() => () => clearTimeout(timer.current), [])

  const finish = useCallback(
    (id: string, box: BoundingBox, original: BoundingBox) => {
      setPreview(null)
      if (!sameBox(box, original)) commit?.(id, box)
    },
    [commit]
  )

  /** Arrow keys on a selected region; true when the key was used. */
  const nudge = useCallback(
    (redaction: Redaction, key: string, shift: boolean): boolean => {
      const original = redaction.boundingBox
      if (!original || !commit) return false
      const base = latest.current?.id === redaction.id ? latest.current.box : original
      const next = nudgeBox(base, key, shift, 1, bounds)
      if (!next) return false
      setPreview({ id: redaction.id, box: next })
      latest.current = { id: redaction.id, box: next }
      clearTimeout(timer.current)
      timer.current = setTimeout(() => finish(redaction.id, next, original), 500)
      return true
    },
    [bounds, commit, finish]
  )

  const boxOf = useCallback(
    (redaction: Redaction): BoundingBox | undefined =>
      preview?.id === redaction.id ? preview.box : redaction.boundingBox,
    [preview]
  )

  return { preview, setPreview, finish, nudge, boxOf }
}

const HANDLES: Exclude<BoxHandle, "move">[] = ["nw", "ne", "sw", "se"]

/**
 * The move area and four corner handles over a selected region, in page
 * units inside the zoomed layer. Handles are painted small and hit big on a
 * coarse pointer (`hit-expand` with the layer's `--hit-size`).
 */
export function RegionHandles({
  box,
  zoom,
  bounds,
  onPreview,
  onCommit,
  onTap,
}: {
  box: BoundingBox
  zoom: number
  bounds: { width: number; height: number }
  onPreview: (box: BoundingBox | null) => void
  onCommit: (box: BoundingBox) => void
  /** A press on the region that did not move it. */
  onTap: (event: ReactPointerEvent<HTMLElement>) => void
}) {
  const drag = useRef<{
    handle: BoxHandle
    pointerId: number
    startX: number
    startY: number
    box: BoundingBox
    moved: boolean
  } | null>(null)

  const begin = (handle: BoxHandle, event: ReactPointerEvent<HTMLElement>) => {
    // The layer under this must not start a new region.
    event.stopPropagation()
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      box,
      moved: false,
    }
  }

  const next = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current) return null
    return adjustBox(
      current.box,
      current.handle,
      (event.clientX - current.startX) / zoom,
      (event.clientY - current.startY) / zoom,
      bounds
    )
  }

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 3) {
      current.moved = true
    }
    if (current.moved) onPreview(next(event))
  }

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const box = next(event)
    drag.current = null
    if (!current.moved) {
      onPreview(null)
      if (current.handle === "move") onTap(event)
      return
    }
    if (box) onCommit(box)
  }

  const cancel = () => {
    if (!drag.current) return
    drag.current = null
    onPreview(null)
  }

  const handleSize = 10 / zoom
  const common = {
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
  }

  return (
    <>
      <div
        aria-hidden
        {...common}
        onPointerDown={(event) => begin("move", event)}
        className="absolute cursor-move touch-none"
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      />
      {HANDLES.map((handle) => (
        <div
          key={handle}
          aria-hidden
          {...common}
          onPointerDown={(event) => begin(handle, event)}
          className={cn(
            "hit-expand absolute touch-none rounded-full border border-primary bg-white shadow",
            handle === "nw" || handle === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize"
          )}
          style={{
            left: (handle.endsWith("w") ? box.x : box.x + box.width) - handleSize / 2,
            top: (handle.startsWith("n") ? box.y : box.y + box.height) - handleSize / 2,
            width: handleSize,
            height: handleSize,
            borderWidth: 1.5 / zoom,
          }}
        />
      ))}
    </>
  )
}

/**
 * The touch equivalent of the inspector's row for one redaction: a small
 * menu anchored to it. Accept is always an explicit press here: a tap never
 * accepts by itself.
 *
 * Rendered into the body because the canvas layer is transformed, and a
 * fixed element inside a transform is positioned against the transform.
 */
export function RedactionPopover({
  redaction,
  anchor,
  actions,
  onClose,
}: {
  redaction: Redaction
  anchor: HTMLElement
  actions: RedactionLayerActions
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const accepted = redaction.status === "accepted"
  const what = redaction.text || (redaction.type === "face" ? "Face" : redaction.category)

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const target = anchor.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const below = target.bottom + 8
    const top =
      below + height < window.innerHeight - 8 ? below : Math.max(8, target.top - height - 8)
    const left = Math.min(
      Math.max(8, target.left + target.width / 2 - width / 2),
      window.innerWidth - width - 8
    )
    setPosition({ left, top })
    menu.querySelector<HTMLElement>("button")?.focus({ preventScroll: true })
  }, [anchor])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    // Scrolling or zooming moves the anchor; a menu left behind points at
    // nothing.
    const onScroll = () => onClose()
    document.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", onScroll)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", onScroll)
    }
  }, [onClose])

  const act = (action: () => void) => () => {
    action()
    onClose()
  }

  const item =
    "flex min-h-11 items-center gap-2 rounded-md px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Actions for ${what}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onClose()
          anchor.focus({ preventScroll: true })
        }
      }}
      style={position ?? { left: -9999, top: -9999 }}
      className="fixed z-50 flex max-w-[calc(100vw-16px)] flex-col gap-1 rounded-lg border border-border bg-surface-2 p-1.5 shadow-panel motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95"
    >
      <p className="max-w-64 truncate px-2 pt-1 pb-0.5 text-[11px] text-text-muted">
        <span className="uppercase">{redaction.category}</span>
        {redaction.text ? ` · ${redaction.text}` : ""}
        {accepted ? " · redacted" : " · suggested"}
      </p>
      <div className="flex flex-wrap gap-1">
        {accepted ? (
          <button type="button" onClick={act(() => actions.reject(redaction.id))} className={cn(item, "text-white hover:bg-white/6")}>
            <Undo2 className="size-4" />
            Unredact
          </button>
        ) : (
          <>
            <button type="button" onClick={act(() => actions.accept(redaction.id))} className={cn(item, "bg-red-soft font-medium text-primary hover:bg-primary/20")}>
              <Check className="size-4" />
              Accept
            </button>
            <button type="button" onClick={act(() => actions.reject(redaction.id))} className={cn(item, "text-white hover:bg-white/6")}>
              <X className="size-4" />
              Ignore
            </button>
          </>
        )}
        {redaction.source === "user" ? (
          <button type="button" onClick={act(() => actions.remove(redaction.id))} className={cn(item, "text-white hover:bg-white/6")}>
            <Trash2 className="size-4" />
            Delete
          </button>
        ) : null}
        <button type="button" onClick={act(() => actions.inspect(redaction.id))} className={cn(item, "text-text-secondary hover:bg-white/6")}>
          <Info className="size-4" />
          Details
        </button>
      </div>
    </div>,
    document.body
  )
}

/**
 * A moment's outline around what a tap just redacted. On a touch screen
 * there is no hover to show what a tap will take, so it shows what it took.
 */
export function TapFlash({ boxes, onDone }: { boxes: BoundingBox[]; onDone: () => void }) {
  return (
    <>
      {boxes.map((box, index) => (
        <div
          key={index}
          aria-hidden
          onAnimationEnd={index === 0 ? onDone : undefined}
          className="tap-flash pointer-events-none absolute rounded-[2px] bg-primary/35 ring-2 ring-primary"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
      ))}
    </>
  )
}
