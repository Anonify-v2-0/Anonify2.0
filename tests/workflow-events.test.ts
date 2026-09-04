import { describe, expect, it } from "vitest"

import { decodeStreamEvent, encodeStreamEvent } from "@/lib/workflows/events"

describe("processing stream events", () => {
  it("round-trips an event as one newline-delimited record", () => {
    const event = {
      type: "document.normalizing" as const,
      documentId: "doc_1",
      at: new Date().toISOString(),
      status: "normalizing" as const,
      progress: 55,
    }

    const encoded = encodeStreamEvent(event)
    expect(encoded.endsWith("\n")).toBe(true)
    expect(encoded.trim().includes("\n")).toBe(false)
    expect(decodeStreamEvent(encoded)).toEqual(event)
  })

  it("ignores blank and malformed lines rather than throwing", () => {
    expect(decodeStreamEvent("")).toBeNull()
    expect(decodeStreamEvent("   ")).toBeNull()
    expect(decodeStreamEvent("not json")).toBeNull()
  })

  it("keeps document text out of the wire format", () => {
    const encoded = encodeStreamEvent({
      type: "document.ready",
      documentId: "doc_1",
      at: "2026-01-01T00:00:00.000Z",
      payload: { pageCount: 3 },
    })

    expect(encoded).toContain("pageCount")
    expect(encoded.length).toBeLessThan(200)
  })
})
