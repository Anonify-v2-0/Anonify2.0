import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * Finding your way through a large batch, against a real database.
 *
 * The workspace asks where the open document sits in its batch on every page
 * it renders, and the documents page lists the batch with each document's
 * redaction counts. Both are about more than fifty documents — a mailbox of
 * any size is a batch of that many — and both are answered by queries whose
 * ordering and counting only exist in Postgres.
 */

const { prisma } = await import("@/lib/database/prisma")
const { batchPositionFor } = await import("@/lib/documents/batches")
const { listBatchDocumentIds, listBatchDocuments } =
  await import("@/lib/documents/listing")

const owner = testFingerprint("batch-navigation")

/** Past the fifty a session's own list stops at. */
const SIZE = 60

type Seeded = { batchId: string; ids: string[]; expiredId: string }

async function seed(): Promise<Seeded> {
  const batchId = testId("batch")
  await prisma.batch.create({ data: { id: batchId, userFingerprint: owner } })

  const start = Date.now() - 60 * 60 * 1000
  const createdAt = Array.from(
    { length: SIZE },
    (_, index) => new Date(start + index * 1000)
  )
  // Two documents created in the same instant, as a mailbox's messages can
  // be. Their order has to be the same on every read.
  createdAt[31] = createdAt[30]

  const rows = createdAt.map((at) => ({ id: testId("doc"), createdAt: at }))
  const expiredId = testId("doc")

  await prisma.document.createMany({
    data: [
      ...rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        originalName: `${row.id}.eml`,
        kind: "eml",
        mimeType: "message/rfc822",
        size: 1,
        status: "ready",
        userFingerprint: owner,
        batchId,
        expiresAt: new Date(Date.now() + 3600 * 1000),
      })),
      {
        id: expiredId,
        createdAt: new Date(start + 45_500),
        originalName: "expired.eml",
        kind: "eml",
        mimeType: "message/rfc822",
        size: 1,
        status: "ready",
        userFingerprint: owner,
        batchId,
        expiresAt: new Date(Date.now() - 1000),
      },
    ],
  })

  // Redactions in every status, on documents either side of fifty.
  const statuses = ["suggested", "accepted", "rejected"]
  await prisma.redaction.createMany({
    data: rows.flatMap((row, index) =>
      Array.from({ length: index % 5 }, (_, count) => ({
        id: testId("red"),
        documentId: row.id,
        source: "ai",
        type: "text",
        category: "email",
        status: statuses[(index + count) % statuses.length],
        text: "someone@example.com",
      }))
    ),
  })

  const ids = [...rows]
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    .map((row) => row.id)

  return { batchId, ids, expiredId }
}

describe.skipIf(!hasDatabase)(
  "navigating a large batch against Postgres",
  () => {
    let seeded: Seeded

    beforeAll(async () => {
      seeded = await seed()
    })

    afterAll(async () => {
      await prisma.document.deleteMany({ where: { userFingerprint: owner } })
      await prisma.batch.deleteMany({ where: { userFingerprint: owner } })
    })

    it("places a document past the fiftieth in its batch", async () => {
      const { batchId, ids } = seeded

      expect(await batchPositionFor(ids[54], batchId)).toMatchObject({
        batchId,
        position: 55,
        total: SIZE,
        previousId: ids[53],
        nextId: ids[55],
      })
      expect(await batchPositionFor(ids[50], batchId)).toMatchObject({
        position: 51,
        previousId: ids[49],
        nextId: ids[51],
      })
      expect(await batchPositionFor(ids[SIZE - 1], batchId)).toMatchObject({
        position: SIZE,
        previousId: ids[SIZE - 2],
        nextId: null,
      })
    })

    it("orders the batch the same way for navigation and for the list", async () => {
      const { batchId, ids } = seeded
      const listed = await listBatchDocuments(batchId)

      expect(await listBatchDocumentIds(batchId)).toEqual(ids)
      expect(listed.map((document) => document.id)).toEqual(ids)
    })

    it("leaves an expired document out of the batch", async () => {
      const { batchId, expiredId } = seeded

      expect(await batchPositionFor(expiredId, batchId)).toBeNull()
      expect(await listBatchDocumentIds(batchId)).not.toContain(expiredId)
    })

    it("counts every document's redactions, by status", async () => {
      const { batchId } = seeded
      const listed = await listBatchDocuments(batchId)
      const rows = await prisma.redaction.findMany({
        where: { documentId: { in: listed.map((document) => document.id) } },
        select: { documentId: true, status: true },
      })

      for (const document of listed) {
        const mine = rows.filter((row) => row.documentId === document.id)
        expect(document.counts).toEqual({
          total: mine.length,
          suggested: mine.filter((row) => row.status === "suggested").length,
          accepted: mine.filter((row) => row.status === "accepted").length,
        })
      }
      // Some of them past the fiftieth, and some with none at all.
      expect(listed[54].counts.total).toBeGreaterThan(0)
      expect(listed.some((document) => document.counts.total === 0)).toBe(true)
    })
  }
)
