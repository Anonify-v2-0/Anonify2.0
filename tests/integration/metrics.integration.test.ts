import { describe, expect, it } from "vitest"

import { hasDatabase } from "./support"

/**
 * The queue-depth query against graphile-worker's real schema (#188).
 *
 * The schema is internal to graphile-worker and changes between versions.
 * This is the test that fails, loudly, when a package bump moves the columns
 * the metrics and the documented KEDA query read. CI's database job applies
 * the workflow schema before it runs (`pnpm workflow:bootstrap`).
 */

describe.skipIf(!hasDatabase)("queue depth", async () => {
  const { prisma } = await import("@/lib/database/prisma")
  const { queueDepthSql, readQueueDepth } = await import("@/lib/metrics/queue")

  it("runs against the migrated schema, and counts what is there", async () => {
    // A ready step job, a locked one and one not due yet, under the world's
    // own task names.
    await prisma.$executeRawUnsafe(`
      SELECT graphile_worker.add_job('workflow_steps', '{}'::json, run_at := now() - interval '30 seconds', job_key := 'metrics-ready');
      `)
    await prisma.$executeRawUnsafe(`
      SELECT graphile_worker.add_job('workflow_steps', '{}'::json, run_at := now() + interval '1 hour', job_key := 'metrics-later');
      `)
    await prisma.$executeRawUnsafe(`
      SELECT graphile_worker.add_job('workflow_flows', '{}'::json, job_key := 'metrics-locked');
      `)
    await prisma.$executeRawUnsafe(`
      UPDATE graphile_worker._private_jobs SET locked_at = now(), locked_by = 'metrics-test'
      WHERE key = 'metrics-locked'`)

    try {
      // The query itself, as published for KEDA, runs as written.
      await prisma.$queryRawUnsafe(queueDepthSql())

      const depth = await readQueueDepth()
      const step = depth.find((entry) => entry.queue === "step")!
      const workflow = depth.find((entry) => entry.queue === "workflow")!
      expect(step.ready).toBeGreaterThanOrEqual(1)
      expect(step.oldestReadySeconds).toBeGreaterThanOrEqual(29)
      expect(workflow.locked).toBeGreaterThanOrEqual(1)
    } finally {
      await prisma.$executeRawUnsafe(
        `SELECT graphile_worker.remove_job(key) FROM unnest(ARRAY['metrics-ready','metrics-later','metrics-locked']) AS key`
      )
      await prisma.$executeRawUnsafe(
        `DELETE FROM graphile_worker._private_jobs WHERE key IN ('metrics-ready','metrics-later','metrics-locked')`
      )
    }
  })
})
