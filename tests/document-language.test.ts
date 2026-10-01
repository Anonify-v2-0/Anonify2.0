import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Reading back the language a document was analysed in, for the editor.
 *
 * From the newest run only, like a degraded pass: a document reprocessed
 * after its text changed is described by the run that produced what the
 * reviewer is looking at.
 */

const findFirst = vi.fn()

vi.mock("@/lib/database/prisma", () => ({
  prisma: {
    processingEvent: { findFirst: (...args: unknown[]) => findFirst(...args) },
    aiUsage: { findMany: async () => [] },
  },
}))

const { readDocumentLanguage } = await import("@/lib/ai/usage-report")

afterEach(() => {
  findFirst.mockReset()
})

describe("reading back the language a document was read in", () => {
  it("returns the language and whether it was detected", async () => {
    const queued = new Date("2026-10-01T10:00:00Z")
    findFirst.mockResolvedValueOnce({ at: queued }).mockResolvedValueOnce({
      type: "document.language",
      payload: { language: "de", detected: true },
    })

    expect(await readDocumentLanguage("doc_1")).toEqual({
      language: "de",
      detected: true,
    })
    expect(findFirst.mock.calls[1][0].where).toMatchObject({
      type: "document.language",
      at: { gte: queued },
    })
  })

  it("returns null before analysis has run", async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    expect(await readDocumentLanguage("doc_1")).toBeNull()
  })

  it("returns null for a payload it does not recognise", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ payload: { language: "ja", detected: true } })
    expect(await readDocumentLanguage("doc_1")).toBeNull()
  })
})
