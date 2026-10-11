import { afterAll, describe, expect, it } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * Runs a dead worker left behind (#182), against a real database: whether a
 * document counts as stuck is a question about its row and its events.
 */

describe.skipIf(!hasDatabase)("lost-run recovery", async () => {
  const { prisma } = await import("@/lib/database/prisma")
  const { MAX_RECOVERIES, recoverLostRuns } =
    await import("@/lib/workflows/recovery")

  const created: string[] = []
  const minutes = 20
  const longAgo = new Date(Date.now() - 60 * 60_000)

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { id: { in: created } } })
  })

  async function seedRunning(
    input: { recoveries?: number; status?: string } = {}
  ): Promise<{ id: string; runId: string }> {
    const id = testId("doc")
    const runId = testId("wrun")
    const owner = testFingerprint("recovery")
    await prisma.document.create({
      data: {
        id,
        originalName: "scan.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
        size: 6,
        status: input.status ?? "extracting",
        userFingerprint: owner,
        quotaKey: owner,
        ttlSeconds: 3600,
        expiresAt: new Date(Date.now() + 3_600_000),
        workflowRunId: runId,
        ...(input.recoveries !== undefined
          ? { metadata: { recoveries: input.recoveries, kept: "yes" } }
          : {}),
      },
    })
    // @updatedAt is set by Prisma on every write, so the age is set directly.
    await prisma.$executeRaw`UPDATE "Document" SET "updatedAt" = ${longAgo} WHERE id = ${id}`
    created.push(id)
    return { id, runId }
  }

  function canceller() {
    const cancelled: string[] = []
    return {
      cancelled,
      cancel: async (runId: string) => {
        cancelled.push(runId)
      },
    }
  }

  it("cancels a run that stopped moving and queues the document again", async () => {
    const { id, runId } = await seedRunning({ recoveries: 0 })
    const { cancelled, cancel } = canceller()

    const result = await recoverLostRuns(cancel, { minutes })
    expect(result.requeued).toBeGreaterThanOrEqual(1)
    expect(cancelled).toContain(runId)

    const row = await prisma.document.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe("queued")
    expect(row.workflowRunId).toBeNull()
    // Counted, and nothing else in the metadata lost.
    expect(row.metadata).toEqual({ recoveries: 1, kept: "yes" })
  })

  it("leaves alone a run that is still writing events", async () => {
    const { id, runId } = await seedRunning()
    await prisma.processingEvent.create({
      data: { id: testId("evt"), documentId: id, type: "document.progress" },
    })
    const { cancelled, cancel } = canceller()

    await recoverLostRuns(cancel, { minutes })
    expect(cancelled).not.toContain(runId)
    const row = await prisma.document.findUniqueOrThrow({ where: { id } })
    expect(row.workflowRunId).toBe(runId)
  })

  it("fails the document with worker-lost once it has been restarted enough", async () => {
    const { id } = await seedRunning({ recoveries: MAX_RECOVERIES })
    const { cancel } = canceller()

    await recoverLostRuns(cancel, { minutes })
    const row = await prisma.document.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe("failed")
    expect(row.errorCode).toBe("worker-lost")
    const event = await prisma.processingEvent.findFirst({
      where: { documentId: id, type: "document.failed" },
    })
    expect(event?.payload).toEqual({ code: "worker-lost", retryable: true })
  })

  it("leaves the document for the next sweep when its run will not cancel", async () => {
    const { id, runId } = await seedRunning()
    await recoverLostRuns(
      async () => {
        throw new Error("world unreachable")
      },
      { minutes }
    )
    const row = await prisma.document.findUniqueOrThrow({ where: { id } })
    expect(row.workflowRunId).toBe(runId)
    expect(row.status).toBe("extracting")
  })
})
