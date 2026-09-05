import { randomBytes } from "node:crypto"

import { config as loadEnv } from "dotenv"

/**
 * Bootstrapping for the database-backed suites.
 *
 * These tests exercise the real persistence layer — the same Prisma client the
 * application uses, against a real Postgres — because the things they are
 * about only exist there: deletion ordering, a unique constraint doing the
 * work of an upsert, an increment that has to be atomic. A fake would agree
 * with whatever the code did.
 *
 * The database is named by `TEST_DATABASE_URL` and nothing else. It is never
 * `DATABASE_URL`: these suites create and delete rows, and pointing them at a
 * working database would be a data-loss bug wearing a test's clothes. When the
 * variable is unset the suites skip, so a clone with no Postgres still runs
 * `pnpm test` to completion.
 */

// The connection string usually lives in .env, which vitest does not read.
loadEnv({ path: ".env", quiet: true })

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim()

/** True when there is a database to run against. */
export const hasDatabase = Boolean(TEST_DATABASE_URL)

if (TEST_DATABASE_URL) {
  // The application's client reads DATABASE_URL when it first connects, which
  // has not happened yet: it is created lazily on the first query.
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

// Storage is the local filesystem for these suites regardless of what the
// developer has configured, so a stray Blob token cannot send test objects at
// a real bucket.
process.env.STORAGE_DRIVER = "local"
delete process.env.BLOB_READ_WRITE_TOKEN

process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64")
process.env.FINGERPRINT_SECRET ??= randomBytes(32).toString("hex")

/** A fingerprint nothing else in the database will collide with. */
export function testFingerprint(label: string): string {
  return `test_${label}_${randomBytes(8).toString("hex")}`
}

export function testId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`
}
