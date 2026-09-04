import { describe, expect, it } from "vitest"

import { makeStore } from "@/store/store"
import {
  redactionAdded,
  redactionRemoved,
  redactionStatusSet,
  redactionsReplaced,
} from "@/store/redactionSlice"
import { zoomChanged, zoomStepped } from "@/store/editorSlice"
import { MAX_ZOOM, MIN_ZOOM } from "@/store/editorSlice"
import { confidenceBand } from "@/types/redaction"
import type { Redaction } from "@/types/redaction"

function redaction(id: string, overrides: Partial<Redaction> = {}): Redaction {
  return {
    id,
    documentId: "doc_1",
    type: "text",
    source: "ai",
    category: "email",
    status: "suggested",
    ...overrides,
  }
}

describe("redaction slice", () => {
  it("normalizes redactions into entities and ids", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([redaction("a"), redaction("b")]))

    expect(store.getState().redactions.ids).toEqual(["a", "b"])
    expect(store.getState().redactions.entities.a.category).toBe("email")
  })

  it("does not duplicate ids when re-adding the same redaction", () => {
    const store = makeStore()
    store.dispatch(redactionAdded(redaction("a")))
    store.dispatch(redactionAdded(redaction("a", { category: "person" })))

    expect(store.getState().redactions.ids).toEqual(["a"])
    expect(store.getState().redactions.entities.a.category).toBe("person")
  })

  it("accepts and rejects in bulk", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([redaction("a"), redaction("b")]))
    store.dispatch(redactionStatusSet({ ids: ["a", "b"], status: "accepted" }))

    expect(store.getState().redactions.entities.a.status).toBe("accepted")
    expect(store.getState().redactions.entities.b.status).toBe("accepted")
  })

  it("clears the selection when the selected redaction is removed", () => {
    const store = makeStore()
    store.dispatch(redactionAdded(redaction("a")))
    store.dispatch(redactionRemoved("a"))

    expect(store.getState().redactions.selectedId).toBeNull()
    expect(store.getState().redactions.ids).toEqual([])
  })
})

describe("editor slice", () => {
  it("clamps zoom to the supported range", () => {
    const store = makeStore()
    store.dispatch(zoomChanged(99))
    expect(store.getState().editor.zoom).toBe(MAX_ZOOM)

    store.dispatch(zoomChanged(0))
    expect(store.getState().editor.zoom).toBe(MIN_ZOOM)

    store.dispatch(zoomStepped(0.25))
    expect(store.getState().editor.zoom).toBe(MIN_ZOOM + 0.25)
  })
})

describe("confidence bands", () => {
  it("maps scores to the three UI bands", () => {
    expect(confidenceBand(0.98)).toBe("high")
    expect(confidenceBand(0.7)).toBe("medium")
    expect(confidenceBand(0.2)).toBe("low")
    expect(confidenceBand(undefined)).toBe("medium")
  })
})
