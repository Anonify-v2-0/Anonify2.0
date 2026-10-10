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
    await seedWaiting(owner, 2, 4)
    vi.stubEnv(
      "ANONIFY_PROCESSING_GLOBAL_MAX",
      String(await inFlightEverywhere())
    )

    const { started, start } = recorder()
    expect(await admitQueued(owner, start)).toBe(0)
    expect(started).toEqual([])
  })

  it("admits each owner as far as their own limit without a cap", async () => {
    const owner = testFingerprint("uncapped")
    const ids = await seedWaiting(owner, 3, 5)
    const { started, start } = recorder()
    await admitQueued(owner, start)
    expect(started).toEqual(ids)
  })
})
