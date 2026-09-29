import type { BoundingBox } from "@/types/document"

/**
 * Drawing a region on a canvas, as a state machine.
 *
 * Both canvases (the PDF annotation layer and the image editor) feed their
 * pointer events through this, so they agree on the one decision #158 asked
 * to be made once:
 *
 *   A finger scrolls in the select tool. Drawing with a finger needs the
 *   redact tool. A mouse draws in either, as it always has.
 *
 * And on what ends a draft: the pointer that started it lifting (commit),
 * the browser taking the gesture back (`pointercancel`, lost capture), or a
 * second finger arriving (a pinch, not a rectangle). Only a lift commits, and
 * only a box big enough to be deliberate.
 */

/** Anything smaller than this is a stray tap, not a redaction. */
export const MIN_DRAG_PX = 6

export type Point = { x: number; y: number }

export type DrawState =
  | { kind: "idle" }
  | {
      kind: "drafting"
      pointerId: number
      startX: number
      startY: number
      x: number
      y: number
    }

export type DrawEvent =
  | {
      type: "down"
      pointerId: number
      pointerType: string
      button: number
      tool: "select" | "redact" | "pan"
      point: Point
    }
  | { type: "move"; pointerId: number; point: Point }
  | { type: "up"; pointerId: number }
  | { type: "cancel"; pointerId: number }

export const IDLE: DrawState = { kind: "idle" }

/** Whether a pointer going down may start a draft; see the rule above. */
export function canStartDraw(
  tool: "select" | "redact" | "pan",
  pointerType: string,
  button: number
): boolean {
  if (button !== 0 || tool === "pan") return false
  if (pointerType === "mouse") return true
  // Touch and pen: only on purpose.
  return tool === "redact"
}

export function draftBox(state: DrawState): BoundingBox | null {
  if (state.kind !== "drafting") return null
  return {
    x: Math.min(state.startX, state.x),
    y: Math.min(state.startY, state.y),
    width: Math.abs(state.x - state.startX),
    height: Math.abs(state.y - state.startY),
  }
}

/**
 * The next state, and the box to create when a draft is committed. A box is
 * returned only on the lift of the pointer that started the draft.
 */
export function drawReducer(
  state: DrawState,
  event: DrawEvent
): { state: DrawState; commit: BoundingBox | null } {
  switch (event.type) {
    case "down": {
      // A second pointer while drafting is a pinch: the draft is abandoned
      // rather than turned into a rectangle between two fingers.
      if (state.kind === "drafting") return { state: IDLE, commit: null }
      if (!canStartDraw(event.tool, event.pointerType, event.button)) {
        return { state, commit: null }
      }
      return {
        state: {
          kind: "drafting",
          pointerId: event.pointerId,
          startX: event.point.x,
          startY: event.point.y,
          x: event.point.x,
          y: event.point.y,
        },
        commit: null,
      }
    }
    case "move":
      if (state.kind !== "drafting" || state.pointerId !== event.pointerId) {
        return { state, commit: null }
      }
      return {
        state: { ...state, x: event.point.x, y: event.point.y },
        commit: null,
      }
    case "up": {
      if (state.kind !== "drafting" || state.pointerId !== event.pointerId) {
        return { state, commit: null }
      }
      const box = draftBox(state)
      const deliberate =
        box !== null && box.width >= MIN_DRAG_PX && box.height >= MIN_DRAG_PX
      return { state: IDLE, commit: deliberate ? box : null }
    }
    case "cancel":
      if (state.kind !== "drafting" || state.pointerId !== event.pointerId) {
        return { state, commit: null }
      }
      return { state: IDLE, commit: null }
  }
}

/**
 * The `touch-action` a drawing surface needs for the tool in hand. The
 * browser only lets go of a finger it was told it may not scroll with, so the
 * redact tool is the one place a touch is ours; everywhere else one finger
 * pans. Pinch is never the browser's over the canvas: the canvas zooms itself
 * (see hooks/use-pinch-zoom.ts), and two zooms fighting is worse than none.
 */
export function surfaceTouchAction(tool: "select" | "redact" | "pan"): string {
  return tool === "redact" ? "none" : "pan-x pan-y"
}
