"use client"

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import { pinchScrollCorrection, type Point } from "@/lib/editor/touch-geometry"
import { MAX_ZOOM, MIN_ZOOM, zoomChanged } from "@/store/editorSlice"
import { useAppDispatch } from "@/store/hooks"

/**
 * Pinch to zoom the page, anchored where the fingers are.
 *
 * The zoom it sets is the toolbar's: `zoomChanged`, so the slider, the
 * percentage and the fit buttons stay in step, and a pinch leaves fit-to-width
 * the way dragging the slider does.
 *
 * While the fingers move, the page is scaled with a CSS transform around the
 * pinch's midpoint, and nothing is re-rendered: a PDF page rasterized at every
 * step of a pinch flickers white. When the fingers lift, the zoom is committed
 * once and the scroll is corrected so the point that was under the fingers
 * when the pinch started is under them now.
 *
 * Also Ctrl + wheel, which is what a trackpad's pinch sends, so a laptop gets
 * the same gesture instead of zooming the whole browser.
 *
 * The container carries `touch-action: pan-x pan-y` (see draw-gesture.ts), so
 * the browser leaves pinches over the canvas to this and still scrolls it.
 */
export function usePinchZoom(
  containerRef: RefObject<HTMLElement | null>,
  zoom: number,
  enabled = true
) {
  const dispatch = useAppDispatch()
  const zoomRef = useRef(zoom)
  const pending = useRef<{ anchor: Point; midpoint: Point } | null>(null)

  useLayoutEffect(() => {
    zoomRef.current = zoom
    // The committed zoom is laid out: put the anchor back under the fingers.
    const container = containerRef.current
    const wanted = pending.current
    const surface = surfaceOf(container)
    if (!container || !wanted || !surface) return
    pending.current = null
    const rect = surface.getBoundingClientRect()
    const correction = pinchScrollCorrection({
      pageLeft: rect.left,
      pageTop: rect.top,
      anchor: wanted.anchor,
      midpoint: wanted.midpoint,
      zoom,
    })
    container.scrollLeft += correction.x
    container.scrollTop += correction.y
  }, [containerRef, zoom])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return

    let pinch: {
      startDistance: number
      startZoom: number
      anchor: Point
      origin: Point
      start: Point
      midpoint: Point
      scale: number
      surface: HTMLElement
    } | null = null

    function commit(scale: number, midpoint: Point, anchor: Point) {
      const next = clampZoom(zoomRef.current * scale)
      if (Math.abs(next - zoomRef.current) < 0.005) return
      pending.current = { anchor, midpoint }
      dispatch(zoomChanged(Number(next.toFixed(3))))
    }

    function onTouchStart(event: TouchEvent) {
      if (event.touches.length !== 2) return
      const surface = surfaceOf(container)
      if (!surface) return
      const [a, b] = [event.touches[0], event.touches[1]]
      const midpoint = {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      }
      const rect = surface.getBoundingClientRect()
      pinch = {
        startDistance: Math.max(
          1,
          Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        ),
        startZoom: zoomRef.current,
        anchor: {
          x: (midpoint.x - rect.left) / zoomRef.current,
          y: (midpoint.y - rect.top) / zoomRef.current,
        },
        origin: { x: midpoint.x - rect.left, y: midpoint.y - rect.top },
        start: midpoint,
        midpoint,
        scale: 1,
        surface,
      }
      surface.style.transformOrigin = `${pinch.origin.x}px ${pinch.origin.y}px`
    }

    function onTouchMove(event: TouchEvent) {
      if (!pinch || event.touches.length !== 2) return
      // Ours, not the browser's: nothing else is allowed to zoom the page.
      event.preventDefault()
      const [a, b] = [event.touches[0], event.touches[1]]
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const target = clampZoom(
        pinch.startZoom * (distance / pinch.startDistance)
      )
      pinch.scale = target / pinch.startZoom
      pinch.midpoint = {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      }
      // Scaled around where the pinch began, and carried along with the
      // fingers as they move together.
      const shift = {
        x: pinch.midpoint.x - pinch.start.x,
        y: pinch.midpoint.y - pinch.start.y,
      }
      pinch.surface.style.transform = `translate(${shift.x}px, ${shift.y}px) scale(${pinch.scale})`
    }

    function onTouchEnd(event: TouchEvent) {
      if (!pinch || event.touches.length >= 2) return
      const { surface, scale, midpoint, anchor } = pinch
      pinch = null
      surface.style.transform = ""
      surface.style.transformOrigin = ""
      commit(scale, midpoint, anchor)
    }

    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey) return
      const surface = surfaceOf(container)
      if (!surface) return
      event.preventDefault()
      const rect = surface.getBoundingClientRect()
      const midpoint = { x: event.clientX, y: event.clientY }
      const anchor = {
        x: (midpoint.x - rect.left) / zoomRef.current,
        y: (midpoint.y - rect.top) / zoomRef.current,
      }
      // A trackpad pinch sends many small deltas; a mouse wheel notch with
      // Ctrl held sends about 100, which is a quarter or so more zoom.
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      commit(Math.exp(-delta / 400), midpoint, anchor)
    }

    // iOS Safari zooms the page on its own gesture events regardless of
    // touch-action; declining them keeps the pinch ours.
    const onGesture = (event: Event) => event.preventDefault()

    container.addEventListener("touchstart", onTouchStart, { passive: true })
    container.addEventListener("touchmove", onTouchMove, { passive: false })
    container.addEventListener("touchend", onTouchEnd)
    container.addEventListener("touchcancel", onTouchEnd)
    container.addEventListener("wheel", onWheel, { passive: false })
    container.addEventListener("gesturestart", onGesture)
    container.addEventListener("gesturechange", onGesture)
    return () => {
      container.removeEventListener("touchstart", onTouchStart)
      container.removeEventListener("touchmove", onTouchMove)
      container.removeEventListener("touchend", onTouchEnd)
      container.removeEventListener("touchcancel", onTouchEnd)
      container.removeEventListener("wheel", onWheel)
      container.removeEventListener("gesturestart", onGesture)
      container.removeEventListener("gesturechange", onGesture)
    }
  }, [containerRef, dispatch, enabled])
}

/** The element that is the page: marked by each viewer with `data-zoom-surface`. */
function surfaceOf(container: HTMLElement | null): HTMLElement | null {
  return container?.querySelector<HTMLElement>("[data-zoom-surface]") ?? null
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}
