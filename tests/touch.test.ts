import { describe, expect, it } from "vitest"

import {
  canStartDraw,
  draftBox,
  drawReducer,
  IDLE,
  surfaceTouchAction,
  type DrawEvent,
  type DrawState,
} from "@/lib/editor/draw-gesture"
import { settleSheet, stepSheet } from "@/lib/editor/sheet"
import {
  adjustBox,
  nearestBox,
  nudgeBox,
  pinchScrollCorrection,
} from "@/lib/editor/touch-geometry"
import { redactionPatchSchema } from "@/lib/redaction/patch"

/**
 * Touch on the review canvas (#45) and the sheets it opens (#157).
 *
 * The gesture rules are a state machine fed with the fields of a
 * `PointerEvent`, so these run without a browser: a `pointerType: "touch"`
 * down, move, cancel or lift is exactly what the canvas passes in.
 */

function run(events: DrawEvent[], from: DrawState = IDLE) {
  let state = from
  const commits = []
  for (const event of events) {
    const result = drawReducer(state, event)
    state = result.state
    if (result.commit) commits.push(result.commit)
  }
  return { state, commits }
}

const touchDown = (
  tool: "select" | "redact",
  x = 10,
  y = 10,
  pointerId = 1
): DrawEvent => ({
  type: "down",
  pointerId,
  pointerType: "touch",
  button: 0,
  tool,
  point: { x, y },
})

describe("drawing a region", () => {
  it("lets one finger scroll in the select tool", () => {
    expect(canStartDraw("select", "touch", 0)).toBe(false)
    expect(run([touchDown("select")]).state).toEqual(IDLE)
    expect(surfaceTouchAction("select")).toBe("pan-x pan-y")
  })

  it("draws with a finger in the redact tool, and takes the gesture from the browser", () => {
    expect(surfaceTouchAction("redact")).toBe("none")
    const { state, commits } = run([
      touchDown("redact"),
      { type: "move", pointerId: 1, point: { x: 60, y: 40 } },
      { type: "up", pointerId: 1 },
    ])
    expect(state).toEqual(IDLE)
    expect(commits).toEqual([{ x: 10, y: 10, width: 50, height: 30 }])
  })

  it("keeps drawing with a mouse in the select tool, as it always has", () => {
    expect(canStartDraw("select", "mouse", 0)).toBe(true)
    expect(canStartDraw("select", "mouse", 2)).toBe(false)
    expect(canStartDraw("pan", "mouse", 0)).toBe(false)
  })

  it("discards the draft when the browser cancels the pointer", () => {
    const { state, commits } = run([
      touchDown("redact"),
      { type: "move", pointerId: 1, point: { x: 60, y: 40 } },
      { type: "cancel", pointerId: 1 },
      // The lift that used to finish a stuck draft much later.
      { type: "up", pointerId: 1 },
    ])
    expect(state).toEqual(IDLE)
    expect(commits).toEqual([])
  })

  it("abandons the draft when a second finger lands: that is a pinch", () => {
    const { state, commits } = run([
      touchDown("redact"),
      { type: "move", pointerId: 1, point: { x: 60, y: 40 } },
      touchDown("redact", 100, 100, 2),
      { type: "up", pointerId: 1 },
      { type: "up", pointerId: 2 },
    ])
    expect(state).toEqual(IDLE)
    expect(commits).toEqual([])
  })

  it("ignores moves and lifts from other pointers", () => {
    const { state } = run([
      touchDown("redact"),
      { type: "move", pointerId: 9, point: { x: 90, y: 90 } },
      { type: "up", pointerId: 9 },
    ])
    expect(draftBox(state)).toEqual({ x: 10, y: 10, width: 0, height: 0 })
  })

  it("treats a small wobble as a tap, not a box", () => {
    const { commits } = run([
      touchDown("redact"),
      { type: "move", pointerId: 1, point: { x: 13, y: 12 } },
      { type: "up", pointerId: 1 },
    ])
    expect(commits).toEqual([])
  })
})

describe("finger-sized targets", () => {
  const words = [
    { x: 0, y: 0, width: 20, height: 5 },
    { x: 30, y: 0, width: 20, height: 5 },
    null,
  ]

  it("takes the word under the finger", () => {
    expect(nearestBox({ x: 35, y: 2 }, words, 10)).toBe(1)
  })

  it("takes the nearest word within reach of a tap that missed", () => {
    expect(nearestBox({ x: 24, y: 2 }, words, 10)).toBe(0)
    expect(nearestBox({ x: 27, y: 12 }, words, 10)).toBe(1)
  })

  it("takes nothing when every word is out of reach", () => {
    expect(nearestBox({ x: 100, y: 100 }, words, 10)).toBeNull()
  })
})

describe("moving and resizing a region", () => {
  const box = { x: 10, y: 10, width: 20, height: 20 }
  const page = { width: 100, height: 100 }

  it("moves, but not off the page", () => {
    expect(adjustBox(box, "move", 5, -3, page)).toEqual({
      x: 15,
      y: 7,
      width: 20,
      height: 20,
    })
    expect(adjustBox(box, "move", -50, 500, page)).toEqual({
      x: 0,
      y: 80,
      width: 20,
      height: 20,
    })
  })

  it("resizes from a corner, keeping the opposite corner where it was", () => {
    expect(adjustBox(box, "se", 10, 5, page)).toEqual({
      x: 10,
      y: 10,
      width: 30,
      height: 25,
    })
    expect(adjustBox(box, "nw", -5, -5, page)).toEqual({
      x: 5,
      y: 5,
      width: 25,
      height: 25,
    })
  })

  it("never shrinks a region below a deliberate box, or turns it inside out", () => {
    const tiny = adjustBox(box, "nw", 100, 100, page)
    expect(tiny.width).toBeGreaterThanOrEqual(6)
    expect(tiny.height).toBeGreaterThanOrEqual(6)
    expect(tiny.x + tiny.width).toBe(30)
  })

  it("nudges from the keyboard, and resizes with Shift", () => {
    expect(nudgeBox(box, "ArrowRight", false, 1, page)).toEqual({
      ...box,
      x: 11,
    })
    expect(nudgeBox(box, "ArrowDown", true, 1, page)).toEqual({
      ...box,
      height: 21,
    })
    expect(nudgeBox(box, "Enter", false, 1, page)).toBeNull()
  })
})

describe("pinch to zoom", () => {
  it("keeps the point under the fingers under them", () => {
    // Page point (100, 50) was under the midpoint; after zooming to 2 the
    // page's corner lands at (-40, 10) and the fingers are at (170, 120).
    const correction = pinchScrollCorrection({
      pageLeft: -40,
      pageTop: 10,
      anchor: { x: 100, y: 50 },
      midpoint: { x: 170, y: 120 },
      zoom: 2,
    })
    // Scrolling by this puts the corner at midpoint − anchor × zoom.
    expect(-40 - correction.x).toBe(170 - 200)
    expect(10 - correction.y).toBe(120 - 100)
  })
})

describe("where a sheet comes to rest", () => {
  const heights = [240, 440, 740]

  it("settles on the nearest snap point", () => {
    expect(settleSheet({ heights, from: 1, height: 700, velocity: 0 })).toEqual(
      {
        close: false,
        snap: 2,
      }
    )
    expect(settleSheet({ heights, from: 2, height: 300, velocity: 0 })).toEqual(
      {
        close: false,
        snap: 0,
      }
    )
  })

  it("closes when dragged well below the lowest point", () => {
    expect(settleSheet({ heights, from: 0, height: 100, velocity: 0 })).toEqual(
      { close: true }
    )
  })

  it("closes on a long fast swipe down, rather than stopping at the next point", () => {
    expect(settleSheet({ heights, from: 1, height: 120, velocity: 2 })).toEqual(
      { close: true }
    )
    expect(settleSheet({ heights, from: 2, height: 300, velocity: 2 })).toEqual(
      {
        close: false,
        snap: 0,
      }
    )
  })

  it("moves one step on a flick, and a flick down from the bottom closes", () => {
    expect(settleSheet({ heights, from: 1, height: 430, velocity: 1 })).toEqual(
      {
        close: false,
        snap: 0,
      }
    )
    expect(
      settleSheet({ heights, from: 1, height: 450, velocity: -1 })
    ).toEqual({
      close: false,
      snap: 2,
    })
    expect(settleSheet({ heights, from: 0, height: 230, velocity: 1 })).toEqual(
      { close: true }
    )
  })

  it("steps from the keyboard the same way", () => {
    expect(stepSheet(3, 1, "up")).toEqual({ close: false, snap: 2 })
    expect(stepSheet(3, 2, "up")).toEqual({ close: false, snap: 2 })
    expect(stepSheet(3, 0, "down")).toEqual({ close: true })
  })
})

describe("saving a moved region", () => {
  const box = { x: 1, y: 2, width: 3, height: 4 }

  it("accepts one region and its new box", () => {
    expect(
      redactionPatchSchema.safeParse({ ids: ["r"], boundingBox: box }).success
    ).toBe(true)
  })

  it("refuses a move that also tries to accept", () => {
    expect(
      redactionPatchSchema.safeParse({
        ids: ["r"],
        boundingBox: box,
        status: "accepted",
      }).success
    ).toBe(false)
  })

  it("refuses moving several regions to one box, or off the page", () => {
    expect(
      redactionPatchSchema.safeParse({ ids: ["a", "b"], boundingBox: box })
        .success
    ).toBe(false)
    expect(
      redactionPatchSchema.safeParse({
        ids: ["r"],
        boundingBox: { ...box, x: -1 },
      }).success
    ).toBe(false)
  })

  it("still takes a plain accept", () => {
    expect(
      redactionPatchSchema.safeParse({ ids: ["a", "b"], status: "accepted" })
        .success
    ).toBe(true)
  })
})
