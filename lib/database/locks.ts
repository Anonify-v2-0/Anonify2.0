import { prisma } from "@/lib/database/prisma"
import { databasePoolConfig } from "@/lib/database/pool-config"

/**
 * One holder at a time, across every replica (#170).
 *
 * The expiry sweep can be started by a platform cron, a Compose scheduler,
 * `pnpm cleanup`, and later by every replica's own timer (#183). It is
 * idempotent, so two at once are not wrong, only wasteful: twice the storage
 * calls and twice the log. This makes the second one step aside.
 *
 * The lock is Postgres's transaction-scoped advisory lock, held by an
 * interactive transaction that stays open while `work` runs on other
 * connections. A transaction, not a session lock on a connection of its own:
 * it needs no driver beyond Prisma, it is released by commit, rollback or a
 * crashed process alike, and a transaction pooler (#169) keeps a transaction
 * on one server connection where it would not keep a session.
 *
 * It holds one of the app pool's connections while it runs. With a pool of
 * one, `work` could never get a connection of its own, so there it runs
 * without the lock: the overlap the lock prevents is only waste.
 */

export type LockOutcome<T> = { acquired: true; result: T } | { acquired: false }

/** The longest a timer can wait: setTimeout's ceiling, about 24.8 days. */
const LONGEST_MS = 2 ** 31 - 1
/** Room past `holdMs` for the last piece of work and the commit. */
const MARGIN_MS = 60_000

export async function withAdvisoryLock<T>(
  name: string,
  holdMs: number,
  work: () => Promise<T>
): Promise<LockOutcome<T>> {
  if (databasePoolConfig().max === 1) {
    return { acquired: true, result: await work() }
  }

  let outcome: LockOutcome<T> | undefined
  try {
    await prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${name})) AS locked`
        if (!row?.locked) {
          outcome = { acquired: false }
          return
        }
        outcome = { acquired: true, result: await work() }
      },
      {
        maxWait: 10_000,
        timeout: Math.min(LONGEST_MS, holdMs + MARGIN_MS),
      }
    )
  } catch (error) {
    // The work finished but the transaction had outlived its timeout, so the
    // commit was refused. The lock went with the transaction either way;
    // what the work did is done, and is the answer.
    if (outcome) return outcome
    throw error
  }
  return outcome ?? { acquired: false }
}
