import { Pool } from "pg"

import { prisma } from "@/lib/database/prisma"

/**
 * The job queue's depth, read from graphile-worker's own schema (#188).
 *
 * Workers should scale on the backlog: how many jobs are ready and how long
 * the oldest has waited. graphile-worker keeps its jobs in its own schema,
 * which is internal and changes between versions, so this reads only the
 * `jobs` view's stable columns (`task_identifier`, `run_at`, `locked_at`,
 * `attempts`, `max_attempts`), and a test runs it against a migrated database
 * so a package bump that changes them fails loudly.
 *
 * The same query is published in docs/operations.md as the KEDA `postgresql`
 * scaler's, so a platform that scales to zero can read the backlog without the
 * app running.
 */

/** A job that could run now: unlocked, attempts left, due. */
const READY =
  "locked_at IS NULL AND attempts < max_attempts AND run_at <= now()"

/** The schema graphile-worker uses: `GRAPHILE_WORKER_SCHEMA`, else its default. */
export function graphileSchema(
  env: Record<string, string | undefined> = process.env
): string {
  const schema = env.GRAPHILE_WORKER_SCHEMA?.trim() || "graphile_worker"
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(schema))
    throw new Error("GRAPHILE_WORKER_SCHEMA must be a plain identifier")
  return schema
}

export function queueDepthSql(schema = graphileSchema()): string {
  return `SELECT task_identifier,
  count(*) FILTER (WHERE ${READY})::int AS ready,
  count(*) FILTER (WHERE locked_at IS NOT NULL)::int AS locked,
  COALESCE(EXTRACT(EPOCH FROM now() - min(run_at) FILTER (WHERE ${READY})), 0)::float8 AS oldest_ready_seconds
FROM "${schema}".jobs
GROUP BY task_identifier`
}

export type QueueDepth = {
  queue: "workflow" | "step" | "other"
  ready: number
  locked: number
  oldestReadySeconds: number
}

/**
 * The world names its two task lists `<prefix>flows` and `<prefix>steps`
 * (`WORKFLOW_POSTGRES_JOB_PREFIX`, default `workflow_`).
 */
export function queueOf(taskIdentifier: string): QueueDepth["queue"] {
  if (taskIdentifier.endsWith("flows")) return "workflow"
  if (taskIdentifier.endsWith("steps")) return "step"
  return "other"
}

type Row = {
  task_identifier: string
  ready: number
  locked: number
  oldest_ready_seconds: number
}

const shared = globalThis as unknown as { anonifyQueuePool?: Pool }

/**
 * Runs the query where the queue lives. That is the app's database unless
 * `WORKFLOW_POSTGRES_URL` names another (a direct connection beside a pooled
 * `DATABASE_URL`, #169), and then one connection of its own, opened for a
 * scrape and closed when idle.
 */
async function queryQueue(sql: string): Promise<Row[]> {
  const world = process.env.WORKFLOW_POSTGRES_URL?.trim()
  if (!world || world === process.env.DATABASE_URL?.trim()) {
    return prisma.$queryRawUnsafe<Row[]>(sql)
  }
  shared.anonifyQueuePool ??= new Pool({
    connectionString: world,
    max: 1,
    idleTimeoutMillis: 30_000,
  })
  const { rows } = await shared.anonifyQueuePool.query<Row>(sql)
  return rows
}

/** Depth per queue, summed over the task lists that map to it. */
export async function readQueueDepth(): Promise<QueueDepth[]> {
  const rows = await queryQueue(queueDepthSql())
  const byQueue = new Map<QueueDepth["queue"], QueueDepth>()
  for (const queue of ["workflow", "step"] as const) {
    byQueue.set(queue, { queue, ready: 0, locked: 0, oldestReadySeconds: 0 })
  }
  for (const row of rows) {
    const queue = queueOf(row.task_identifier)
    const depth = byQueue.get(queue) ?? {
      queue,
      ready: 0,
      locked: 0,
      oldestReadySeconds: 0,
    }
    depth.ready += Number(row.ready)
    depth.locked += Number(row.locked)
    depth.oldestReadySeconds = Math.max(
      depth.oldestReadySeconds,
      Number(row.oldest_ready_seconds)
    )
    byQueue.set(queue, depth)
  }
  return [...byQueue.values()]
}
