import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { handleRouteError } from "@/lib/api/http"
import { categoriesAllowing } from "@/lib/redaction/methods"
import { exportOptionsSchema } from "@/lib/redaction/export-options"

/**
 * What the export route will accept.
 *
 * Every "…and a pseudonymized copy" export used to fail with a 500: in Zod 4 a
 * record keyed by an enum is exhaustive, and the dialog only ever names the
 * categories it wants to change.
 */
describe("export options", () => {
  it("accepts a methods map that names only some categories", () => {
    const parsed = exportOptionsSchema.safeParse({
      variants: [
        { addLabels: false },
        { addLabels: false, methods: categoriesAllowing("pseudonymize") },
      ],
    })

    expect(parsed.success).toBe(true)
  })

  it("accepts the partial map the dialog sends for every second copy", () => {
    for (const method of ["pseudonymize", "tokenize", "encrypt"] as const) {
      const methods = categoriesAllowing(method)
      expect(exportOptionsSchema.safeParse({ methods }).success).toBe(true)
    }
  })

  it("still refuses a method or a category that is not ours", () => {
    expect(
      exportOptionsSchema.safeParse({ methods: { person: "shred" } }).success
    ).toBe(false)
    expect(
      exportOptionsSchema.safeParse({ methods: { horoscope: "mask" } }).success
    ).toBe(false)
  })

  it("reads an empty body as the default export", () => {
    const parsed = exportOptionsSchema.parse({})
    expect(parsed).toMatchObject({
      addLabels: false,
      sanitizeMetadata: true,
      imageStyle: "solid",
    })
    expect(parsed.methods).toBeUndefined()
  })
})

describe("a request that fails validation", () => {
  it("is answered as the caller's mistake, not as an outage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = z.object({ a: z.string() }).safeParse({ a: 1 }).error

    const response = handleRouteError(error, "test.route")

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Invalid request" })
    // The path is logged so the next one is diagnosable; the value is not.
    expect(warn.mock.calls[0]?.[0]).toContain('"path":"a"')
    expect(warn.mock.calls[0]?.[0]).not.toContain("1}")
    warn.mockRestore()
  })
})
