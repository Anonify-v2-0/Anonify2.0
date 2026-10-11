import { existsSync } from "node:fs"

import { PDFDocument, StandardFonts } from "pdf-lib"
import * as pdfLib from "pdf-lib"
import { afterAll, describe, expect, it } from "vitest"

import { extractPdfText, redactPdf } from "@/lib/documents/pdf/redact"
import { rebuildPdf } from "@/lib/documents/pdf/rebuild-core.mjs"
import {
  pdfLibModuleUrl,
  rebuildThreadEntry,
} from "@/lib/documents/pdf/rebuild"
import { closeRenderPool } from "@/lib/documents/pdf/render-pool"

/**
 * Rebuilding a very large export on a thread (#245).
 *
 * The thread and the main thread run the same rebuild-core.mjs, so for the
 * same input they must write the same file, byte for byte: a reviewer cannot
 * get a different export for having uploaded a larger scan.
 */

const SECRET = "Josephine Marchetti"

afterAll(async () => {
  await closeRenderPool()
})

async function letters(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= pages; number++) {
    const page = pdf.addPage([612, 792])
    page.drawText(
      number % 2 === 0 ? `Dear ${SECRET},` : `Page ${number} says nothing`,
      { x: 72, y: 700, size: 14, font }
    )
    page.drawText(`Footer of page ${number}`, { x: 72, y: 60, size: 10, font })
  }
  return pdf.save()
}

/** Every even page carries the name, at the top. */
function evenPages(pages: number) {
  return new Map(
    Array.from({ length: Math.floor(pages / 2) }, (_, at) => [
      (at + 1) * 2,
      [{ x: 60, y: 80, width: 400, height: 30 }],
    ])
  )
}

describe("rebuilding a redacted PDF on a thread", () => {
  it("finds the thread's entry and pdf-lib, so it does not fall back to the main thread", () => {
    // Without them the rebuild warns and runs here, and every test below
    // would pass for comparing the main thread with itself.
    expect(existsSync(rebuildThreadEntry())).toBe(true)
    expect(pdfLibModuleUrl()).toMatch(/pdf-lib\.esm\.min\.js$/)
  })

  it("writes the same file as the main thread", async () => {
    const source = await letters(6)
    const plan = {
      boxesByPage: evenPages(6),
      label: null,
      sanitizeMetadata: true,
      scale: 1,
    }
    const main = await redactPdf(source, { ...plan, rebuild: "main" })
    const thread = await redactPdf(source, { ...plan, rebuild: "thread" })

    expect(Buffer.from(thread).equals(Buffer.from(main))).toBe(true)
    const text = await extractPdfText(thread)
    expect(text).not.toContain(SECRET)
    expect(text).toContain("Footer of page 1")
  })

  it("leaves the caller's source readable for the next variant", async () => {
    const source = await letters(2)
    const before = Buffer.from(source)
    await redactPdf(source, {
      boxesByPage: evenPages(2),
      label: null,
      sanitizeMetadata: true,
      scale: 1,
      rebuild: "thread",
    })
    expect(source.byteLength).toBe(before.byteLength)
    expect(Buffer.from(source).equals(before)).toBe(true)
  })

  it("fails with pdf-lib's reason when the thread cannot read the source", async () => {
    await expect(
      redactPdf(new TextEncoder().encode("not a pdf at all"), {
        boxesByPage: new Map(),
        label: null,
        sanitizeMetadata: true,
        rebuild: "thread",
      })
    ).rejects.toThrow(/PDF|header/i)
  })
})

describe("rebuild-core", () => {
  it("refuses to copy through a page it was told to redact but has no drawing of", async () => {
    const source = await letters(3)
    await expect(
      rebuildPdf(pdfLib, source, {
        redacted: new Set([1]),
        drawn: new Map(),
        sanitizeMetadata: false,
      })
    ).rejects.toThrow(/Page 2 is to be redacted but was not drawn/)
  })
})
