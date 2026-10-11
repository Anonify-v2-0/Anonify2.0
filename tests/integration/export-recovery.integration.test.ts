import { afterAll, describe, expect, it } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * Export runs a dead worker left behind (#243), against a real database:
 * whether an export counts as lost is a question about its row's age, and the
 * restart is a guarded write that has to lose to anything that moved it.
 */

describe.skipIf(!hasDatabase)("lost export recovery", async () => {
  const { prisma } = await import("@/lib/database/prisma")
  const { MAX_RECOVERIES } = await import("@/lib/workflows/recovery")
  const { EXPORT_LOST_MESSAGE, recoverLostExports } =
    await import("@/lib/workflows/export-recovery")

  const documents: string[] = []
  const batches: string[] = []
  const minutes = 20
  const longAgo = new Date(Date.now() - 60 * 60_000)

  afterAll(async () => {
    // Exports go with their document or batch.
    await prisma.document.deleteMany({ where: { id: { in: documents } } })
    await prisma.batch.deleteMany({ where: { id: { in: batches } } })
  })

  async function seedDocumentExport(
    input: {
      recoveries?: number
      cancelRequested?: boolean
      stale?: boolean
    } = {}
  ): Promise<{ id: string; runId: string }> {
    const documentId = testId("doc")
    const owner = testFingerprint("export-recovery")
    await prisma.document.create({
      data: {
        id: documentId,
        originalName: "scan.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
        size: 6,
        status: "ready",
        userFingerprint: owner,
        quotaKey: owner,
        ttlSeconds: 3600,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    documents.push(documentId)

    const id = testId("exp")
    const runId = testId("wrun")
    await prisma.documentExport.create({
      data: {
        id,
        documentId,
        status: "running",
        workflowRunId: runId,
        variants: [],
        recoveries: input.recoveries ?? 0,
        cancelRequested: input.cancelRequested ?? false,
      },
    })
    // @updatedAt is set by Prisma on every write, so the age is set directly.
    if (input.stale !== false)
      await prisma.$executeRaw`UPDATE "DocumentExport" SET "updatedAt" = ${longAgo} WHERE id = ${id}`
    return { id, runId }
  }

  async function seedBatchExport(
    input: { recoveries?: number } = {}
  ): Promise<{ id: string; runId: string }> {
    const batchId = testId("batch")
    await prisma.batch.create({
      data: {
        id: batchId,
        userFingerprint: testFingerprint("export-recovery"),
      },
    })
    batches.push(batchId)

    const id = testId("bexp")
    const runId = testId("wrun")
    await prisma.batchExport.create({
      data: {
        id,
        batchId,
        status: "running",
        workflowRunId: runId,
        total: 3,
        completed: 1,
        recoveries: input.recoveries ?? 0,
      },
    })
    await prisma.$executeRaw`UPDATE "BatchExport" SET "updatedAt" = ${longAgo} WHERE id = ${id}`
    return { id, runId }
  }

  function harness() {
    const cancelled: string[] = []
    const started: { kind: "document" | "batch"; exportId: string }[] = []
    return {
      cancelled,
      started,
      cancel: async (runId: string) => {
        cancelled.push(runId)
      },
      restarts: {
        document: async (exportId: string) => {
          started.push({ kind: "document" as const, exportId })
          return testId("wrun")
        },
        batch: async (exportId: string) => {
          started.push({ kind: "batch" as const, exportId })
          return testId("wrun")
        },
      },
    }
  }

  it("cancels a background export that stopped moving and starts it again", async () => {
    const { id, runId } = await seedDocumentExport()
    const { cancelled, started, cancel, restarts } = harness()

    const result = await recoverLostExports(cancel, restarts, { minutes })
    expect(result.restarted).toBeGreaterThanOrEqual(1)
    expect(cancelled).toContain(runId)
    expect(started).toContainEqual({ kind: "document", exportId: id })

    const row = await prisma.documentExport.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe("running")
    expect(row.workflowRunId).not.toBe(runId)
    expect(row.recoveries).toBe(1)
  })

  it("starts a batch export again with the batch workflow", async () => {
    const { id, runId } = await seedBatchExport()
    const { cancelled, started, cancel, restarts } = harness()

    await recoverLostExports(cancel, restarts, { minutes })
    expect(cancelled).toContain(runId)
    expect(started).toContainEqual({ kind: "batch", exportId: id })

    const row = await prisma.batchExport.findUniqueOrThrow({ where: { id } })
    expect(row.workflowRunId).not.toBe(runId)
    expect(row.recoveries).toBe(1)
    // Progress so far is kept: the run resumes from its plan.
    expect(row.completed).toBe(1)
  })

  it("leaves alone an export whose row is still changing", async () => {
    const { id, runId } = await seedDocumentExport({ stale: false })
    const { cancelled, cancel, restarts } = harness()

    await recoverLostExports(cancel, restarts, { minutes })
    expect(cancelled).not.toContain(runId)
    const row = await prisma.documentExport.findUniqueOrThrow({ where: { id } })
    expect(row.workflowRunId).toBe(runId)
    expect(row.recoveries).toBe(0)
  })

  it("marks cancelled an export the reviewer had asked to cancel", async () => {
    const { id, runId } = await seedDocumentExport({ cancelRequested: true })
    const { cancelled, started, cancel, restarts } = harness()

    await recoverLostExports(cancel, restarts, { minutes })
    expect(cancelled).toContain(runId)
    expect(started.map((entry) => entry.exportId)).not.toContain(id)
    const row = await prisma.documentExport.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe("cancelled")
  })

  it("fails the export with a sentence once it has been restarted enough", async () => {
    const single = await seedDocumentExport({ recoveries: MAX_RECOVERIES })
    const batch = await seedBatchExport({ recoveries: MAX_RECOVERIES })
    const { started, cancel, restarts } = harness()

    const result = await recoverLostExports(cancel, restarts, { minutes })
    expect(result.failed).toBeGreaterThanOrEqual(2)
    const exportIds = started.map((entry) => entry.exportId)
    expect(exportIds).not.toContain(single.id)
    expect(exportIds).not.toContain(batch.id)

    for (const row of [
      await prisma.documentExport.findUniqueOrThrow({
        where: { id: single.id },
      }),
      await prisma.batchExport.findUniqueOrThrow({ where: { id: batch.id } }),
    ]) {
      expect(row.status).toBe("failed")
      expect(row.error).toBe(EXPORT_LOST_MESSAGE)
    }
  })

  it("leaves the export for the next sweep when its run will not cancel", async () => {
    const { id, runId } = await seedDocumentExport()
    const { started, restarts } = harness()

    await recoverLostExports(
      async () => {
        throw new Error("world unreachable")
      },
      restarts,
      { minutes }
    )
    expect(started.map((entry) => entry.exportId)).not.toContain(id)
    const row = await prisma.documentExport.findUniqueOrThrow({ where: { id } })
    expect(row.workflowRunId).toBe(runId)
    expect(row.recoveries).toBe(0)
  })

  it("stops the new run when something moved the export meanwhile", async () => {
    const { id } = await seedDocumentExport()
    const { cancelled, cancel } = harness()
    const surplus = testId("wrun")

    // The reviewer's own retry lands between the sweep's read and its write.
    const elsewhere = testId("wrun")
    await recoverLostExports(
      cancel,
      {
        document: async (exportId) => {
          if (exportId === id)
            await prisma.documentExport.update({
              where: { id },
              data: { workflowRunId: elsewhere },
            })
          return exportId === id ? surplus : testId("wrun")
        },
        batch: async () => testId("wrun"),
      },
      { minutes }
    )
    expect(cancelled).toContain(surplus)
    const row = await prisma.documentExport.findUniqueOrThrow({ where: { id } })
    expect(row.workflowRunId).toBe(elsewhere)
    expect(row.recoveries).toBe(0)
  })
})
