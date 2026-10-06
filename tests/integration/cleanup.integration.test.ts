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
  /** Called when a delete reaches the gate: the sweep is parked there now. */
  onParked: null as (() => void) | null,
}))

/**
 * Parks the next delete of `key`, and resolves once a sweep is waiting on
 * it. A fixed sleep guessed how long a sweep takes to get there; since the
 * sweep first opens its lock (#170), the guess was sometimes too short.
 */
function park(key: string): { parked: Promise<void>; release: () => void } {
  let release = () => {}
  storage.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  storage.gated.add(key)
  const parked = new Promise<void>((resolve) => {
    storage.onParked = resolve
  })
  return {
    parked,
    release: () => {
      release()
      storage.gate = null
      storage.gated.delete(key)
      storage.onParked = null
    },
  }
}

vi.mock("@/lib/storage/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/blob")>()
  return {
    ...actual,
    deleteObject: async (key: string) => {
      if (storage.gated.has(key) && storage.gate) {
        storage.onParked?.()
        await storage.gate
      }
      if (storage.failing.has(key)) throw new Error("storage unavailable")
      return actual.deleteObject(key)
    },
    // The purge deletes a document's objects in one call (#170); the same
    // failures and the same parking, per key.
    deleteObjects: async (keys: string[]) => {
      if (keys.some((key) => storage.gated.has(key)) && storage.gate) {
        storage.onParked?.()
        await storage.gate
      }
      const failing = keys.filter((key) => storage.failing.has(key))
      const { failed } = await actual.deleteObjects(
        keys.filter((key) => !storage.failing.has(key))
      )
      return { failed: [...failing, ...failed] }
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
    const artifact = await putObject(
      `test/${id}/export-${index}.bin`,
      bytes("x")
    )
    const report = await putObject(
      `test/${id}/report-${index}.json`,
      bytes("{}")
    )
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
      data: {
        id: testId("evt"),
        documentId: seeded.id,
        type: "document.ready",
      },
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
    const { parked, release } = park(seeded.keys[2])

    const sweep = cleanupExpired()

    // While one object's deletion is still in flight the row must still be
    // there. If cleanup deleted the record first, this read would come back
    // null and a storage failure would be unrecoverable.
    await parked
    expect(
      await prisma.document.findUnique({ where: { id: seeded.id } })
    ).not.toBeNull()

    release()
    await sweep
    expect(
      await prisma.document.findUnique({ where: { id: seeded.id } })
    ).toBeNull()
  })

  it("finishes when another process deletes a document mid-sweep", async () => {
    // Three things purge documents and none of them coordinate: this sweep,
    // `pnpm cleanup`, and a person pressing delete. Here the sweep is parked
    // on one document's storage while something else removes that document
    // outright, which is what threw "No record was found for a delete" and
    // failed the whole run with a 500.
    const contested = await seed({ expiresAt: past() })
    const bystander = await seed({ expiresAt: past() })
    const { parked, release } = park(contested.keys[0])

    const sweep = cleanupExpired()
    await parked

    // The other process: its purge has cleared storage and removed the row.
    await prisma.document.delete({ where: { id: contested.id } })

    release()
    const result = await sweep
    expect(result.failures).toBe(0)
    // Gone is what the sweep wanted; it is not a failure that it was not
    // the one to do it. And the rest of the page was still swept.
    expect(
      await prisma.document.findUnique({ where: { id: contested.id } })
    ).toBeNull()
    expect(
      await prisma.document.findUnique({ where: { id: bystander.id } })
    ).toBeNull()
    for (const key of [...contested.keys, ...bystander.keys]) {
      expect(await objectExists(key)).toBe(false)
    }
  })

  it("survives two sweeps running at once", async () => {
    const seeded = await Promise.all([
      seed({ expiresAt: past() }),
      seed({ expiresAt: past() }),
      seed({ expiresAt: past() }),
    ])

    const results = await Promise.all([cleanupExpired(), cleanupExpired()])

    for (const result of results) expect(result.failures).toBe(0)
    for (const document of seeded)
      expect(
        await prisma.document.findUnique({ where: { id: document.id } })
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

/**
 * The whole backlog, a time budget and one sweep at a time (#170). Seeded
 * without going through `seed` above, which writes three objects a document
 * one at a time: 500 of those would be most of the test's time.
 */
describe.skipIf(!hasDatabase)("a sweep through a backlog (#170)", () => {
  const backlogOwner = testFingerprint("backlog")

  async function backlog(count: number, withChildren = 0): Promise<string[]> {
    const ids = Array.from({ length: count }, () => testId("bulk"))
    const objects = await Promise.all(
      ids.map((id) => putObject(`test/${id}/source.bin`, bytes("source")))
    )
    await prisma.document.createMany({
      data: ids.map((id, index) => ({
        id,
        originalName: "seeded.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
        size: 6,
        status: "ready",
        userFingerprint: backlogOwner,
        quotaKey: backlogOwner,
        ttlSeconds: 3600,
        expiresAt: past(),
        sourceBlobKey: objects[index].key,
      })),
    })
    // Messages with an attachment each, the attachment expiring with them.
    const children = ids.slice(0, withChildren).map((parent) => ({
      id: testId("att"),
      parent,
    }))
    const childObjects = await Promise.all(
      children.map((child) =>
        putObject(`test/${child.id}/source.bin`, bytes("attachment"))
      )
    )
    if (children.length > 0)
      await prisma.document.createMany({
        data: children.map((child, index) => ({
          id: child.id,
          parentDocumentId: child.parent,
          sourcePartPath: "1",
          originalName: "attached.pdf",
          kind: "pdf",
          mimeType: "application/pdf",
          size: 10,
          status: "ready",
          userFingerprint: backlogOwner,
          quotaKey: backlogOwner,
          ttlSeconds: 3600,
          expiresAt: past(),
          sourceBlobKey: childObjects[index].key,
        })),
      })
    return [...objects.map((o) => o.key), ...childObjects.map((o) => o.key)]
  }

  async function left(): Promise<number> {
    return prisma.document.count({ where: { userFingerprint: backlogOwner } })
  }

  afterAll(async () => {
    await prisma.document.deleteMany({
      where: { userFingerprint: backlogOwner },
    })
  })

  it("clears 500 expired documents and their attachments in one run, and nothing live", async () => {
    const keys = await backlog(500, 50)
    const live = await seed({ expiresAt: future() })

    const result = await cleanupExpired({ budgetMs: Infinity })

    expect(result.remaining).toBe(false)
    expect(result.failures).toBe(0)
    expect(result.documentsDeleted).toBeGreaterThanOrEqual(550)
    expect(await left()).toBe(0)
    for (const key of keys.slice(0, 20).concat(keys.slice(-20)))
      expect(await objectExists(key)).toBe(false)
    expect(
      await prisma.document.findUnique({ where: { id: live.id } })
    ).not.toBeNull()
  }, 120_000)

  it("stops when its budget is spent, says so, and the next run finishes", async () => {
    await backlog(300)

    const first = await cleanupExpired({ budgetMs: 1 })
    expect(first.remaining).toBe(true)
    expect(await left()).toBeGreaterThan(0)

    const second = await cleanupExpired({ budgetMs: Infinity })
    expect(second.remaining).toBe(false)
    expect(await left()).toBe(0)
  }, 120_000)

  it("lets one sweep at a time do the work, and the other step aside", async () => {
    const document = await seed({ expiresAt: past() })
    const { parked, release } = park(document.keys[0])

    try {
      const first = cleanupExpired({ budgetMs: Infinity })
      // The first holds the lock, parked on a delete.
      await parked
      const second = await cleanupExpired({ budgetMs: Infinity })
      expect(second.skipped).toBe("another sweep is running")
      expect(second.documentsDeleted).toBe(0)

      release()
      const done = await first
      expect(done.skipped).toBeUndefined()
      expect(
        await prisma.document.findUnique({ where: { id: document.id } })
      ).toBeNull()
    } finally {
      release()
    }
  })
})
