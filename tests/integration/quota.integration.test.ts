import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { hasDatabase, testFingerprint } from "./support"

/**
 * Quota accounting, against a real database.
 *
 * A quota is only a quota if it is durable, atomic and charged exactly once,
 * and all three of those are properties of the row rather than of the
 * function. Counting in memory would pass every assertion below while an
 * anonymous visitor spent the demo's whole budget from two tabs.
 */

const { prisma } = await import("@/lib/database/prisma")
const { extractXlsx } = await import("@/lib/documents/xlsx/extract")
const { reserveDocument } = await import("@/lib/documents/reserve")
const {
  chargeDocumentUsage,
  checkQuota,
  recordUsage,
  usageQuantity,
  usageSnapshot,
} = await import("@/lib/security/usage")
const { extractEml } = await import("@/lib/documents/eml/extract")
const { extractPptx } = await import("@/lib/documents/pptx/extract")
const { extractText } = await import("@/lib/documents/text/extract")
const { makeSparseXlsxFixture, makeXlsxFixture } = await import("../fixtures")
const { makePptxFixture } = await import("../pptx-fixtures")
const { bytesOf, mixedEml } = await import("../eml-fixtures")

const QUOTA_ENV = [
  "ANONIFY_PROFILE",
  "ANONIFY_QUOTA_UPLOADS",
  "ANONIFY_QUOTA_XLSX_CELLS",
  "ANONIFY_QUOTA_PDF_PAGES",
  "ANONIFY_QUOTA_PPTX_SLIDES",
]

const seen: string[] = []

function fingerprint(label: string): string {
  const value = testFingerprint(label)
  seen.push(value)
  return value
}

function today(): Date {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
}

async function usageRow(fingerprintValue: string) {
  return prisma.usageRecord.findUnique({
    where: { fingerprint_date: { fingerprint: fingerprintValue, date: today() } },
  })
}

describe.skipIf(!hasDatabase)("quota accounting against Postgres", () => {
  const saved = new Map<string, string | undefined>()

  beforeAll(() => {
    for (const key of QUOTA_ENV) saved.set(key, process.env[key])
  })

  afterEach(() => {
    for (const key of QUOTA_ENV) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  afterAll(async () => {
    for (const value of seen) {
      await prisma.document.deleteMany({ where: { userFingerprint: value } })
      await prisma.usageRecord.deleteMany({ where: { fingerprint: value } })
    }
  })

  it("increments the day's usage exactly once per charge", async () => {
    const key = fingerprint("once")

    await recordUsage({ fingerprint: key, kind: "pdfPages", quantity: 7 })

    const row = await usageRow(key)
    expect(row?.pdfPages).toBe(7)
    // One row per identity per UTC day, not one per charge.
    expect(
      await prisma.usageRecord.count({ where: { fingerprint: key } })
    ).toBe(1)
  })

  it("commits against the named quota type and no other", async () => {
    const key = fingerprint("kinds")

    await recordUsage({ fingerprint: key, kind: "xlsxCells", quantity: 240 })

    const row = await usageRow(key)
    expect(row?.xlsxCells).toBe(240)
    expect(row?.pdfPages).toBe(0)
    expect(row?.docxPages).toBe(0)
    expect(row?.images).toBe(0)
    expect(row?.uploads).toBe(0)
  })

  it("adds concurrent charges rather than losing them", async () => {
    const key = fingerprint("concurrent")

    // The upsert has to be atomic in the database. Read-modify-write in
    // application code passes a serial test and silently drops charges here.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        recordUsage({ fingerprint: key, kind: "images", quantity: 1 })
      )
    )

    expect((await usageRow(key))?.images).toBe(8)
  })

  it("does not consume the allowance for a request it refuses", async () => {
    const key = fingerprint("refused")
    process.env.ANONIFY_PROFILE = "demo"
    process.env.ANONIFY_QUOTA_UPLOADS = "1"

    const first = await reserveDocument({
      filename: "one.pdf",
      size: 1024,
      ttlSeconds: 3600,
      ownerKey: key,
      quotaKey: key,
    })
    expect(first.ok).toBe(true)
    expect((await usageRow(key))?.uploads).toBe(1)

    const refused = await reserveDocument({
      filename: "two.pdf",
      size: 1024,
      ttlSeconds: 3600,
      ownerKey: key,
      quotaKey: key,
    })

    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.reason).toBe("quota")
    // The refusal cost nothing: no second charge, and no row for a document
    // that was never accepted.
    expect((await usageRow(key))?.uploads).toBe(1)
    expect(
      await prisma.document.count({ where: { userFingerprint: key } })
    ).toBe(1)
  })

  it("refuses an unsupported type without touching the allowance", async () => {
    const key = fingerprint("unsupported")

    const refused = await reserveDocument({
      filename: "notes.exe",
      size: 1024,
      ttlSeconds: 3600,
      ownerKey: key,
      quotaKey: key,
    })

    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.reason).toBe("unsupported-type")
    expect(await usageRow(key)).toBeNull()
  })

  it("reports the day's usage without creating a row for a reader", async () => {
    const key = fingerprint("snapshot")

    const before = await usageSnapshot(key)
    expect(before.every((entry) => entry.used === 0)).toBe(true)
    // Asking how much you have used must not record that you have used none.
    expect(await usageRow(key)).toBeNull()

    await recordUsage({ fingerprint: key, kind: "docxPages", quantity: 3 })

    const after = await usageSnapshot(key)
    expect(after.find((entry) => entry.kind === "docxPages")?.used).toBe(3)
  })

  it("reads the remaining allowance without spending any of it", async () => {
    const key = fingerprint("check")
    process.env.ANONIFY_PROFILE = "demo"
    process.env.ANONIFY_QUOTA_PDF_PAGES = "10"

    await recordUsage({ fingerprint: key, kind: "pdfPages", quantity: 4 })

    const check = await checkQuota(key, "pdfPages", 2)
    expect(check.allowed).toBe(true)
    expect(check.used).toBe(4)
    expect(check.remaining).toBe(6)
    expect((await usageRow(key))?.pdfPages).toBe(4)

    const overrun = await checkQuota(key, "pdfPages", 9)
    expect(overrun.allowed).toBe(false)
    expect((await usageRow(key))?.pdfPages).toBe(4)
  })

  describe("workbook cells", () => {
    it("charges filled cells rather than the rectangular used range", async () => {
      const key = fingerprint("sparse")
      const { document } = await extractXlsx("quota", await makeSparseXlsxFixture())

      const sheet = document.sheets?.[0]
      expect(sheet).toBeDefined()
      if (!sheet) return

      // The sheet's used range is wide and tall; almost all of it is blank.
      const rectangle = sheet.rowCount * sheet.columnCount
      const filled = usageQuantity("xlsxCells", document)

      expect(rectangle).toBeGreaterThan(200)
      expect(filled).toBe(sheet.cells.length)
      expect(filled).toBeLessThan(rectangle / 4)

      await recordUsage({ fingerprint: key, kind: "xlsxCells", quantity: filled })
      expect((await usageRow(key))?.xlsxCells).toBe(filled)
    })

    it("counts every sheet, hidden ones included", async () => {
      const { document } = await extractXlsx("quota", await makeXlsxFixture())

      const perSheet = (document.sheets ?? []).map((sheet) => sheet.cells.length)
      expect(perSheet.length).toBeGreaterThan(1)
      expect(usageQuantity("xlsxCells", document)).toBe(
        perSheet.reduce((total, count) => total + count, 0)
      )
    })
  })

  describe("the formats added with the wider format set", () => {
    async function seedDocument(
      key: string,
      kind: string
    ): Promise<string> {
      const id = `doc_quota_${Math.random().toString(16).slice(2)}`
      seen.push(key)

      await prisma.document.create({
        data: {
          id,
          originalName: `fixture.${kind}`,
          kind,
          mimeType: "application/octet-stream",
          size: 1,
          status: "normalizing",
          userFingerprint: key,
          quotaKey: key,
          ttlSeconds: 3600,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      })

      return id
    }

    it("charges a deck by its slides, not by its pages", async () => {
      const key = fingerprint("slides")
      const { document } = extractPptx("quota", makePptxFixture())

      // Layouts and masters get their own review pages; they are processed
      // with the slides rather than charged separately.
      expect(document.pages.length).toBeGreaterThan(2)
      expect(usageQuantity("pptxSlides", document)).toBe(2)

      const id = await seedDocument(key, "pptx")
      const { charged } = await chargeDocumentUsage({
        documentId: id,
        kind: "pptx",
        quotaKey: key,
        metadata: null,
        model: document,
      })

      expect(charged).toBe(true)
      expect((await usageRow(key))?.pptxSlides).toBe(2)
      expect((await usageRow(key))?.pdfPages).toBe(0)
    })

    it("charges an email by the text it actually decoded", async () => {
      const key = fingerprint("email")
      const { document } = extractEml("quota", bytesOf(mixedEml()))

      const kilobytes = usageQuantity("emailKilobytes", document)
      expect(kilobytes).toBeGreaterThanOrEqual(1)

      const id = await seedDocument(key, "eml")
      await chargeDocumentUsage({
        documentId: id,
        kind: "eml",
        quotaKey: key,
        metadata: null,
        model: document,
      })

      expect((await usageRow(key))?.emailKilobytes).toBe(kilobytes)
      // Not counted as pages, which is the point of it having its own unit.
      expect((await usageRow(key))?.pdfPages).toBe(0)
      expect((await usageRow(key))?.textPages).toBe(0)
    })

    it("charges plain text by its pages of extracted text", async () => {
      const key = fingerprint("text")
      const { document } = extractText(
        "quota",
        new TextEncoder().encode("line\n".repeat(2000))
      )

      const pages = usageQuantity("textPages", document)
      expect(pages).toBe(document.pages.length)
      expect(pages).toBeGreaterThan(1)

      const id = await seedDocument(key, "txt")
      await chargeDocumentUsage({
        documentId: id,
        kind: "txt",
        quotaKey: key,
        metadata: null,
        model: document,
      })

      expect((await usageRow(key))?.textPages).toBe(pages)
    })

    it("counts a CSV against the same cells a workbook uses", async () => {
      const key = fingerprint("csvcells")
      const { extractDelimited } = await import(
        "@/lib/documents/delimited/extract"
      )
      const { document } = extractDelimited(
        "quota",
        "csv",
        new TextEncoder().encode("a,b\n1,2\n3,4\n")
      )

      const id = await seedDocument(key, "csv")
      await chargeDocumentUsage({
        documentId: id,
        kind: "csv",
        quotaKey: key,
        metadata: null,
        model: document,
      })

      expect((await usageRow(key))?.xlsxCells).toBe(6)
    })
  })

  describe("retries", () => {
    it("charges a document once however many times the step runs", async () => {
      const key = fingerprint("retry")
      const { document } = extractPptx("quota", makePptxFixture())

      const id = `doc_retry_${Math.random().toString(16).slice(2)}`
      seen.push(key)
      await prisma.document.create({
        data: {
          id,
          originalName: "fixture.pptx",
          kind: "pptx",
          mimeType: "application/octet-stream",
          size: 1,
          status: "normalizing",
          userFingerprint: key,
          quotaKey: key,
          ttlSeconds: 3600,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      })

      const first = await chargeDocumentUsage({
        documentId: id,
        kind: "pptx",
        quotaKey: key,
        metadata: null,
        model: document,
      })
      expect(first.charged).toBe(true)

      // What a retry does: re-read the row, re-extract, charge again. The
      // extraction step is retried on a storage blip and re-extracts from
      // scratch, so without the guard one upload was billed twice.
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await prisma.document.findUnique({ where: { id } })
        const again = await chargeDocumentUsage({
          documentId: id,
          kind: "pptx",
          quotaKey: key,
          metadata: row?.metadata,
          model: document,
        })
        expect(again.charged).toBe(false)
      }

      expect((await usageRow(key))?.pptxSlides).toBe(2)

      // And the row says what it was charged, which is what a retry reads.
      const row = await prisma.document.findUnique({ where: { id } })
      const metadata = row?.metadata as { quotaCharged?: { kind: string } }
      expect(metadata.quotaCharged?.kind).toBe("pptxSlides")
    })

    it("does not charge a document with no quota key", async () => {
      const key = fingerprint("nokey")
      const { document } = extractPptx("quota", makePptxFixture())

      const result = await chargeDocumentUsage({
        documentId: "unused",
        kind: "pptx",
        quotaKey: null,
        metadata: null,
        model: document,
      })

      expect(result.charged).toBe(false)
      expect(await usageRow(key)).toBeNull()
    })
  })
})
