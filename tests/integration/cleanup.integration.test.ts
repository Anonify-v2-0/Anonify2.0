import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * Expiry cleanup, against a real database.
 *
 * The promise this suite protects is an ordering one: a document's row is the
 * only thing that records where its bytes are, so the bytes go first and the
 * row goes second — and only if the bytes actually went. Deleting the row
 * first and hoping would turn one failed delete into orphaned storage nobody
 * is tracking, which for a temporary-by-default product is the whole failure
 * mode.
 *
 * That cannot be tested against a fake: the assertion is about what is durable
 * at each moment.
 */

const storage = vi.hoisted(() => ({
  /** Keys whose deletion should fail, standing in for a storage outage. */
  failing: new Set<string>(),
  /** Resolved by the test to let a deliberately parked delete finish. */
  gate: null as Promise<void> | null,
  /** Keys the gate applies to. */
  gated: new Set<string>(),
}))

vi.mock("@/lib/storage/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/blob")>()
  return {
    ...actual,
    deleteObject: async (key: string) => {
      if (storage.gated.has(key) && storage.gate) await storage.gate
      if (storage.failing.has(key)) throw new Error("storage unavailable")
      return actual.deleteObject(key)
    },
  }
})

const { prisma } = await import("@/lib/database/prisma")
const { cleanupExpired, markExpired } = await import("@/lib/workflows/cleanup")
const { objectExists, putObject } = await import("@/lib/storage/blob")

const owner = testFingerprint("cleanup")

type Seeded = { id: string; keys: string[] }

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value))
}

function past(seconds = 60): Date {
  return new Date(Date.now() - seconds * 1000)
}

function future(seconds = 3600): Date {
  return new Date(Date.now() + seconds * 1000)
}

async function seed(input: {
  expiresAt: Date
  exports?: number
}): Promise<Seeded> {
  const id = testId("doc")

  const source = await putObject(`test/${id}/source.bin`, bytes("source"))
  const normalized = await putObject(`test/${id}/normalized.bin`, bytes("{}"))
  const processed = await putObject(`test/${id}/processed.bin`, bytes("out"))

  await prisma.document.create({
    data: {
      id,
      originalName: "seeded.pdf",
      kind: "pdf",
      mimeType: "application/pdf",
      size: 6,
      status: "ready",
      userFingerprint: owner,
      quotaKey: owner,
      ttlSeconds: 3600,
      expiresAt: input.expiresAt,
      sourceBlobKey: source.key,
      normalizedBlobKey: normalized.key,
      processedBlobKey: processed.key,
    },
  })

  const exportKeys: string[] = []
  for (let index = 0; index < (input.exports ?? 0); index++) {
    const artifact = await putObject(`test/${id}/export-${index}.bin`, bytes("x"))
    const report = await putObject(`test/${id}/report-${index}.json`, bytes("{}"))
    exportKeys.push(artifact.key, report.key)

    await prisma.exportArtifact.create({
      data: {
        id: testId("exp"),
        documentId: id,
        blobKey: artifact.key,
        checksum: "0".repeat(64),
        mimeType: "application/pdf",
        extension: "pdf",
        size: 1,
        reportBlobKey: report.key,
      },
    })
  }

  return {
    id,
    keys: [source.key, normalized.key, processed.key, ...exportKeys],
  }
}

describe.skipIf(!hasDatabase)("cleanup against Postgres", () => {
  beforeAll(async () => {
    await prisma.document.deleteMany({ where: { userFingerprint: owner } })
  })

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { userFingerprint: owner } })
  })

  it("removes an expired document's storage and then its row", async () => {
    const seeded = await seed({ expiresAt: past(), exports: 1 })

    const result = await cleanupExpired()

    expect(result.documentsDeleted).toBeGreaterThanOrEqual(1)
    expect(
      await prisma.document.findUnique({ where: { id: seeded.id } })
    ).toBeNull()

    for (const key of seeded.keys) {
      expect(await objectExists(key)).toBe(false)
    }
  })

  it("cascades the rows a document owns", async () => {
    const seeded = await seed({ expiresAt: past(), exports: 1 })

    await prisma.redaction.create({
      data: {
        id: testId("red"),
        documentId: seeded.id,
        source: "ai",
        type: "text",
        category: "email",
        status: "accepted",
        text: "someone@example.com",
      },
    })
    await prisma.processingEvent.create({
      data: { id: testId("evt"), documentId: seeded.id, type: "document.ready" },
    })

    await cleanupExpired()

    expect(
      await prisma.redaction.count({ where: { documentId: seeded.id } })
    ).toBe(0)
    expect(
      await prisma.processingEvent.count({ where: { documentId: seeded.id } })
    ).toBe(0)
    expect(
      await prisma.exportArtifact.count({ where: { documentId: seeded.id } })
    ).toBe(0)
  })

  it("keeps the row when storage cannot be cleared", async () => {
    const seeded = await seed({ expiresAt: past() })
    const stuck = seeded.keys[1]
    storage.failing.add(stuck)

    try {
      const result = await cleanupExpired()
      expect(result.failures).toBeGreaterThanOrEqual(1)

      const row = await prisma.document.findUnique({ where: { id: seeded.id } })
      expect(row).not.toBeNull()
      // The row still names the object that survived, which is what lets the
      // next sweep finish the job rather than orphan it.
      expect(row?.normalizedBlobKey).toBe(stuck)
      expect(await objectExists(stuck)).toBe(true)
    } finally {
      storage.failing.delete(stuck)
    }

    // And the retry does finish it, with no special-casing anywhere.
    const retry = await cleanupExpired()
    expect(retry.documentsDeleted).toBeGreaterThanOrEqual(1)
    expect(
      await prisma.document.findUnique({ where: { id: seeded.id } })
    ).toBeNull()
  })

  it("does not delete the row before storage has actually cleared", async () => {
    const seeded = await seed({ expiresAt: past() })
    const parked = seeded.keys[2]

    let release = () => {}
    storage.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    storage.gated.add(parked)

    const sweep = cleanupExpired()

    // While one object's deletion is still in flight the row must still be
    // there. If cleanup deleted the record first, this read would come back
    // null and a storage failure would be unrecoverable.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(
      await prisma.document.findUnique({ where: { id: seeded.id } })
    ).not.toBeNull()

    release()
    storage.gate = null
    storage.gated.delete(parked)

    await sweep
    expect(
      await prisma.document.findUnique({ where: { id: seeded.id } })
    ).toBeNull()
  })

  it("leaves a document that has not expired completely alone", async () => {
    const seeded = await seed({ expiresAt: future(), exports: 1 })

    await cleanupExpired()

    const row = await prisma.document.findUnique({ where: { id: seeded.id } })
    expect(row).not.toBeNull()
    expect(row?.status).toBe("ready")
    for (const key of seeded.keys) {
      expect(await objectExists(key)).toBe(true)
    }
  })

  it("marks expired documents without touching live ones", async () => {
    const expired = await seed({ expiresAt: past() })
    const live = await seed({ expiresAt: future() })

    await markExpired()

    expect(
      (await prisma.document.findUnique({ where: { id: expired.id } }))?.status
    ).toBe("expired")
    expect(
      (await prisma.document.findUnique({ where: { id: live.id } }))?.status
    ).toBe("ready")
  })
})
