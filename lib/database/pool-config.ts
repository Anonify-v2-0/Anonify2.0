/**
 * The Postgres connection budget (#169).
 *
 * Postgres is the one stateful dependency every replica shares, and each
 * replica opens connections from two pools: the app's (Prisma) and the
 * workflow world's (runs, steps, the job queue), plus one LISTEN client. A
 * default `max_connections = 100` runs out at a handful of replicas. These
 * settings size the pools, and a malformed value stops the server at start:
 * a limit that looks set and is not in force is worse than no limit.
 *
 * See docs/deploy/database.md for the budget, and for putting a transaction
 * pooler in front of the app while the queue connects directly.
 */

type Env = Record<string, string | undefined>

function integer(
  env: Env,
  name: string,
  min: number,
  max: number
): number | undefined {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  return value
}

export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 10_000

export type DatabasePoolConfig = {
  /** Absent leaves the driver's default, 10 for both node-postgres and Neon. */
  max?: number
  idleTimeoutMillis: number
}

/**
 * DATABASE_POOL_MAX (1–100) and DATABASE_POOL_IDLE_TIMEOUT_MS: the app's own
 * pool. The idle timeout lets a quiet replica give its connections back.
 */
export function databasePoolConfig(env: Env = process.env): DatabasePoolConfig {
  const max = integer(env, "DATABASE_POOL_MAX", 1, 100)
  return {
    ...(max !== undefined ? { max } : {}),
    idleTimeoutMillis:
      integer(env, "DATABASE_POOL_IDLE_TIMEOUT_MS", 0, 3_600_000) ??
      DEFAULT_POOL_IDLE_TIMEOUT_MS,
  }
}

/**
 * The workflow world's own settings. It reads them itself, and ignores a
 * malformed value by falling back to its default; checked here so that
 * cannot happen silently.
 */
export function assertWorkflowPoolSettings(env: Env = process.env): void {
  integer(env, "WORKFLOW_POSTGRES_MAX_POOL_SIZE", 1, 100)
  integer(env, "WORKFLOW_POSTGRES_WORKER_CONCURRENCY", 1, 100)
}

/**
 * Whether a connection string names a transaction pooler: Neon's `-pooler`
 * host, or PgBouncer's and Supabase's port 6543. The job queue cannot run
 * through one: graphile-worker needs LISTEN/NOTIFY and session locks.
 */
export function looksLikePooler(connectionString: string | undefined): boolean {
  if (!connectionString) return false
  return /-pooler\.|:6543(\/|$|\?)/i.test(connectionString)
}
