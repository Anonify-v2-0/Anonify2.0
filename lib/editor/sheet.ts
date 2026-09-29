/**
 * Where a bottom sheet comes to rest after a drag.
 *
 * Kept apart from the component so the rules can be tested without a
 * browser. Heights are in CSS pixels, measured from the bottom of the
 * viewport; velocity is in pixels per millisecond, positive downwards.
 */

export type SheetSnap = "peek" | "half" | "full"

/** Each snap point as a share of the viewport's height. */
export const SNAP_FRACTIONS: Record<SheetSnap, number> = {
  peek: 0.3,
  half: 0.55,
  full: 0.92,
}

/** Faster than this and a drag is a flick: it moves one snap point. */
export const FLICK_VELOCITY = 0.5

/** Dragged below this share of the lowest snap point, the sheet closes. */
export const DISMISS_SHARE = 0.6

export type SheetSettle = { close: true } | { close: false; snap: number }

/**
 * @param heights  the snap points' heights, lowest first
 * @param from     the index the drag started at
 * @param height   the sheet's height where the finger let go
 * @param velocity the finger's speed at release, positive downwards
 */
export function settleSheet({
  heights,
  from,
  height,
  velocity,
}: {
  heights: number[]
  from: number
  height: number
  velocity: number
}): SheetSettle {
  if (heights.length === 0) return { close: true }

  // A flick moves one step in its direction, whatever the distance: that is
  // what a swipe means on every phone.
  if (velocity > FLICK_VELOCITY) {
    return from <= 0 ? { close: true } : { close: false, snap: from - 1 }
  }
  if (velocity < -FLICK_VELOCITY) {
    return { close: false, snap: Math.min(heights.length - 1, from + 1) }
  }

  if (height < heights[0] * DISMISS_SHARE) return { close: true }

  let nearest = 0
  for (let index = 1; index < heights.length; index += 1) {
    if (Math.abs(heights[index] - height) < Math.abs(heights[nearest] - height)) {
      nearest = index
    }
  }
  return { close: false, snap: nearest }
}

/**
 * The next snap point from the keyboard: the handle is a button, and Arrow
 * Up and Down move the sheet the way a drag would. Down from the lowest
 * point closes it, as a swipe would.
 */
export function stepSheet(
  count: number,
  from: number,
  direction: "up" | "down"
): SheetSettle {
  if (direction === "up") {
    return { close: false, snap: Math.min(count - 1, from + 1) }
  }
  return from <= 0 ? { close: true } : { close: false, snap: from - 1 }
}
