import { describe, expect, it } from "vitest"

import { hasDatabase } from "./support"

/**
 * The built-in scheduler against a real database (#183): several replicas'
 * timers, one sweep at a time, and every trigger sharing the same lock.
 */

describe.skipIf(!hasDatabase)("the scheduler across replicas", async () => {
  const { withAdvisoryLock } = await import("@/lib/database/locks")
  const { startScheduler } = await import("@/lib/runtime/scheduler")
  const { SWEEP_LOCK, sweep } = await import("@/lib/workflows/sweep")

  it("lets exactly one replica sweep at a time", async () => {
    let inSweep = 0
    let most = 0
    let led = 0

    // Each replica's tick takes the sweep's lock, as `sweep()` does, around
    // a body that takes a while.
    const replica = () =>
      startScheduler({
        intervalMs: 50,
        log: () => {},
        sweep: async () => {
          const outcome = await withAdvisoryLock(SWEEP_LOCK, 5000, async () => {
            inSweep += 1
            most = Math.max(most, inSweep)
            await new Promise((resolve) => setTimeout(resolve, 40))
            inSweep -= 1
          })
          if (!outcome.acquired) return { skipped: "another sweep is running" }
          led += 1
          return {}
        },
      })

    const replicas = [replica(), replica(), replica()]
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await Promise.all(replicas.map((scheduler) => scheduler.stop()))

    expect(most).toBe(1)
    expect(led).toBeGreaterThan(1)
  })

  it("makes an external trigger step aside while a sweep runs", async () => {
    let release = () => {}
    const holding = withAdvisoryLock(
      SWEEP_LOCK,
      5000,
      () => new Promise<void>((resolve) => (release = resolve))
    )
    // Give the holder time to take the lock.
    await new Promise((resolve) => setTimeout(resolve, 200))

    const result = await sweep({ budgetMs: 1000 })
    expect(result.skipped).toBe("another sweep is running")

    release()
    await holding
  })

  it("answers the route, the CLI and the scheduler in one shape", async () => {
    const result = await sweep({ budgetMs: 5000 })
    expect(result.skipped).toBeUndefined()
    expect(Object.keys(result).sort()).toEqual(
      [
        "admitted",
        "batchesPruned",
        "documentsDeleted",
        "durationMs",
        "failures",
        "marked",
        "objectsDeleted",
        "ownerRulesPruned",
        "rateLimitsPruned",
        "recovered",
        "remaining",
      ].sort()
    )
  })
})
