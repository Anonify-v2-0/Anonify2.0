import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * The global processing cap and its fairness across owners (#181), against a
 * real database: the counts admission reads only exist there.
 */

describe.skipIf(!hasDatabase)("global admission", async () => {
  const { prisma } = await import("@/lib/database/prisma")
  const { admitFairly, admitQueued } = await import("@/lib/documents/admission")

  const created: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { id: { in: created } } })
  })

  /**
   * Waiting documents for one owner, dated far in the past so they are older
   * than anything another suite left waiting, and so first in line.
   */
  async function seedWaiting(owner: string, count: number, day: number) {
    const ids = Array.from({ length: count }, () => testId("doc"))
    await prisma.document.createMany({
      data: ids.map((id, index) => ({
        id,
        originalName: "queued.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
        size: 6,
        status: "queued",
        userFingerprint: owner,
        quotaKey: owner,
        ttlSeconds: 3600,
        expiresAt: new Date(Date.now() + 3_600_000),
        uploadBlobKey: `test/${id}/upload.bin`,
        createdAt: new Date(Date.UTC(2000, 0, day, 0, index)),
      })),
    })
    created.push(...ids)
    return ids
  }

  async function inFlightEverywhere(): Promise<number> {
    return prisma.document.count({
      where: {
        workflowRunId: { not: null },
        status: { in: ["queued", "extracting", "normalizing", "analyzing"] },
        expiresAt: { gt: new Date() },
      },
    })
  }

  function recorder() {
    const started: string[] = []
    const start = async (documentId: string) => {
      started.push(documentId)
      return testId("run")
    }
    return { started, start }
  }

  it("hands slots to owners in turns, oldest waiting first, up to the cap", async () => {
    const first = testFingerprint("big-batch")
    const second = testFingerprint("one-doc")
    const third = testFingerprint("another-doc")
    const batch = await seedWaiting(first, 5, 1)
    const [single] = await seedWaiting(second, 1, 2)
    const [other] = await seedWaiting(third, 1, 3)

    vi.stubEnv(
      "ANONIFY_PROCESSING_GLOBAL_MAX",
      String((await inFlightEverywhere()) + 4)
    )
    const { started, start } = recorder()
    expect(await admitFairly(start)).toBe(4)

    // Without turns, the batch of five would have taken all four.
    expect(started).toEqual([batch[0], single, other, batch[1]])
  })

  it("refuses an owner's document once the cap is reached", async () => {
    const owner = testFingerprint("capped")
    const [running] = await seedWaiting(owner, 3, 4)
    // One of its own in flight, so the cap below is at least one.
    await prisma.document.update({
      where: { id: running },
      data: { workflowRunId: testId("run") },
    })
    vi.stubEnv(
      "ANONIFY_PROCESSING_GLOBAL_MAX",
      String(await inFlightEverywhere())
    )

    const { started, start } = recorder()
    expect(await admitQueued(owner, start)).toBe(0)
    expect(started).toEqual([])
  })

  it("claims a document before starting its run, so two admissions start one run", async () => {
    const owner = testFingerprint("racing")
    const [id] = await seedWaiting(owner, 1, 6)
    const started: string[] = []
    // Both admissions read the document as waiting before either claims it.
    const slowStart = async (documentId: string) => {
      started.push(documentId)
      await new Promise((resolve) => setTimeout(resolve, 50))
      return testId("run")
    }
    const results = await Promise.all([
      admitQueued(owner, slowStart),
      admitQueued(owner, slowStart),
    ])
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(1)
    expect(started).toEqual([id])
    const row = await prisma.document.findUniqueOrThrow({ where: { id } })
    expect(row.workflowRunId).toMatch(/^run_/)
  })

  it("puts a document back when its run cannot start", async () => {
    const owner = testFingerprint("unstartable")
    const [id] = await seedWaiting(owner, 1, 7)
    await expect(
      admitQueued(owner, async () => {
        throw new Error("world unreachable")
      })
    ).rejects.toThrow("world unreachable")
    const row = await prisma.document.findUniqueOrThrow({ where: { id } })
    expect(row.workflowRunId).toBeNull()
  })

  it("admits each owner as far as their own limit without a cap", async () => {
    const owner = testFingerprint("uncapped")
    const ids = await seedWaiting(owner, 3, 5)
    const { started, start } = recorder()
    await admitQueued(owner, start)
    expect(started).toEqual(ids)
  })
})
