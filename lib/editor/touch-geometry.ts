import type { BoundingBox } from "@/types/document"

import { MIN_DRAG_PX, type Point } from "@/lib/editor/draw-gesture"

export type { Point }

/**
 * Geometry for fingers.
 *
 * A finger covers about 44 CSS pixels, and a word in 10 pt text at
 * fit-to-width on a phone is a few pixels tall. The painted boxes stay
 * exactly where the export will put them; these helpers widen what a tap is
 * allowed to mean instead.
 */

/** How far a box is from a point, zero when the point is inside it. */
export function distanceToBox(point: Point, box: BoundingBox): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width))
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height))
  return Math.hypot(dx, dy)
}

/**
 * The index of the box nearest to a tap, if any is within `tolerance`. Ties go
 * to the earlier box, so the result does not depend on floating-point noise.
 */
export function nearestBox(
  point: Point,
  boxes: (BoundingBox | null | undefined)[],
  tolerance: number
): number | null {
  let best: { index: number; distance: number } | null = null
  boxes.forEach((box, index) => {
    if (!box) return
    const distance = distanceToBox(point, box)
    if (distance > tolerance) return
    if (!best || distance < best.distance) best = { index, distance }
  })
  return (best as { index: number } | null)?.index ?? null
}

/** Which part of a selected region a drag is holding. */
export type BoxHandle = "move" | "nw" | "ne" | "sw" | "se"

/**
 * A region moved or resized by a drag of (dx, dy) page units, kept inside the
 * page and never smaller than a deliberate box. The corner opposite the one
 * being dragged stays where it is.
 */
export function adjustBox(
  box: BoundingBox,
  handle: BoxHandle,
  dx: number,
  dy: number,
  bounds: { width: number; height: number }
): BoundingBox {
  if (handle === "move") {
    return {
      ...box,
      x: clamp(box.x + dx, 0, Math.max(0, bounds.width - box.width)),
      y: clamp(box.y + dy, 0, Math.max(0, bounds.height - box.height)),
    }
  }

  let left = box.x
  let top = box.y
  let right = box.x + box.width
  let bottom = box.y + box.height

  if (handle === "nw" || handle === "sw") {
    left = clamp(left + dx, 0, right - MIN_DRAG_PX)
  } else {
    right = clamp(right + dx, left + MIN_DRAG_PX, bounds.width)
  }
  if (handle === "nw" || handle === "ne") {
    top = clamp(top + dy, 0, bottom - MIN_DRAG_PX)
  } else {
    bottom = clamp(bottom + dy, top + MIN_DRAG_PX, bounds.height)
  }

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The same from the keyboard: arrows nudge a region, Shift+arrows resize it
 * from its bottom-right corner. `step` is in page units.
 */
export function nudgeBox(
  box: BoundingBox,
  key: string,
  shift: boolean,
  step: number,
  bounds: { width: number; height: number }
): BoundingBox | null {
  const delta: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }
  const move = delta[key]
  if (!move) return null
  return adjustBox(box, shift ? "se" : "move", move[0], move[1], bounds)
}

export function sameBox(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  )
}

/**
 * Where to scroll after a pinch, so the point that was under the fingers when
 * it started is under them when it ends.
 *
 * `pageLeft`/`pageTop` are where the page's corner sits on screen after the
 * new zoom has been laid out; `anchor` is the point of the page, in page
 * units, that was under the pinch's midpoint; `midpoint` is where the fingers
 * are now. The answer is how far to scroll, added to the current scroll.
 */
export function pinchScrollCorrection({
  pageLeft,
  pageTop,
  anchor,
  midpoint,
  zoom,
}: {
  pageLeft: number
  pageTop: number
  anchor: Point
  midpoint: Point
  zoom: number
}): Point {
  return {
    x: pageLeft - (midpoint.x - anchor.x * zoom),
    y: pageTop - (midpoint.y - anchor.y * zoom),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
