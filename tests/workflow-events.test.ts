import { describe, expect, it } from "vitest"

import {
  decodeBatchExportEvent,
  encodeBatchExportEvent,
  type BatchExportStreamEvent,
} from "@/lib/workflows/batch-export-events"
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

/**
 * The batch export's progress channel. Each event is a whole snapshot, so a
 * client that missed one is corrected by the next rather than drifting — and
 * the wire format still carries nothing about what was found in any document.
 */
describe("batch export stream events", () => {
  const snapshot: BatchExportStreamEvent = {
    type: "export.progress",
    at: "2026-01-01T00:00:00.000Z",
    status: "running",
    total: 3,
    completed: 2,
    exported: 1,
    documents: [
      { id: "doc_1", name: "invoice.pdf", state: "exported", removed: 4 },
      {
        id: "doc_2",
        name: "contract.pdf",
        state: "skipped",
        reason: "verification-failed",
      },
      { id: "doc_3", name: "notes.pdf", state: "exporting" },
    ],
    error: null,
  }

  it("round-trips a snapshot as one newline-delimited record", () => {
    const encoded = encodeBatchExportEvent(snapshot)

    expect(encoded.endsWith("\n")).toBe(true)
    // One line: the reader splits on newlines, so an event that contained one
    // would be read as two broken halves.
    expect(encoded.trim().includes("\n")).toBe(false)
    expect(decodeBatchExportEvent(encoded)).toEqual(snapshot)
  })

  it("ignores blank and malformed lines rather than throwing", () => {
    expect(decodeBatchExportEvent("")).toBeNull()
    expect(decodeBatchExportEvent("   ")).toBeNull()
    expect(decodeBatchExportEvent("not json")).toBeNull()
  })

  it("carries filenames and counts, and nothing from inside a document", () => {
    const encoded = encodeBatchExportEvent(snapshot)

    // Names the reviewer already knows, and how far the run has got.
    expect(encoded).toContain("invoice.pdf")
    expect(encoded).toContain("verification-failed")

    // Nothing about what was detected: a category or a matched value on this
    // channel would put document content in a log nobody thinks of as one.
    for (const forbidden of ["text", "pattern", "category", "confidence"]) {
      expect(encoded).not.toContain(forbidden)
    }
  })
})
