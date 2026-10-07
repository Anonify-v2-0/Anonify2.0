/**
 * `anonify migrate`: the app's schema, then the workflow world's (#175).
 *
 * Both halves are idempotent: Prisma applies only migrations it has not
 * recorded, and the world's setup records its own the same way. What neither
 * is on its own is safe to run twice *at once*. Prisma takes an advisory lock
 * for its half, but the world's setup creates schemas with
 * `CREATE SCHEMA IF NOT EXISTS`, which two sessions can race. So the whole
 * job holds one advisory lock of its own, on a connection kept open for the
 * run: a second replica migrating at the same time waits, then finds nothing
 * to do.
 *
 * Point DATABASE_URL at the database directly, not through a transaction
 * pooler: a session lock does not hold through one, and Prisma's own
 * migrations need a direct connection anyway. See docs/deploy/database.md.
 */
import { spawnSync } from "node:child_process"

import pg from "pg"

const MIGRATE_ROOT = "/opt/anonify/migrate"
const PRISMA = `${MIGRATE_ROOT}/node_modules/prisma/build/index.js`
const WORLD_SETUP = "/node_modules/@workflow/world-postgres/bin/setup.js"

/** "anonify migrate", as a 63-bit integer for pg_advisory_lock. */
const LOCK_KEY = "6120366626537853296"

const url = process.env.DATABASE_URL?.trim()
if (!url) {
  console.error("anonify migrate: DATABASE_URL is not set")
  process.exit(1)
}

const env = {
  ...process.env,
  // Nothing to ask the network about, and nowhere writable to remember it.
  CHECKPOINT_DISABLE: "1",
  PRISMA_HIDE_UPDATE_MESSAGE: "1",
  // prisma.config.ts is compiled on load; on a read-only root filesystem
  // there is nowhere to cache the result.
  JITI_FS_CACHE: "false",
}

function run(label, args, cwd) {
  console.log(`anonify migrate: ${label}`)
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? result.signal})`)
  }
}

const client = new pg.Client({ connectionString: url })
let failed = false

try {
  await client.connect()
  await client.query("SELECT pg_advisory_lock($1::bigint)", [LOCK_KEY])
  try {
    run("prisma migrate deploy", [PRISMA, "migrate", "deploy"], MIGRATE_ROOT)
    run("workflow schema", [WORLD_SETUP], MIGRATE_ROOT)
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY])
  }
  console.log("anonify migrate: done")
} catch (error) {
  failed = true
  console.error(`anonify migrate: ${error instanceof Error ? error.message : error}`)
} finally {
  await client.end().catch(() => {})
}

process.exit(failed ? 1 : 0)
