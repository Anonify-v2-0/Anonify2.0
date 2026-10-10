import { afterEach, describe, expect, it, vi } from "vitest"

import {
  resetSchedulerState,
  schedulerSettings,
  schedulerState,
  startScheduler,
} from "@/lib/runtime/scheduler"

/**
 * The built-in scheduler (#183): its settings, its timer, and the rules that
 * keep it from overlapping itself or outliving the process.
 */

afterEach(() => {
  vi.useRealTimers()
  resetSchedulerState()
})

describe("scheduler settings", () => {
  it("is on, every five minutes, by default", () => {
    expect(schedulerSettings({})).toEqual({
      enabled: true,
      intervalMs: 300_000,
    })
  })

  it("turns off, and takes an interval", () => {
    expect(
      schedulerSettings({
        ANONIFY_SCHEDULER: "OFF",
        ANONIFY_SCHEDULER_INTERVAL_SECONDS: "10",
      })
    ).toEqual({ enabled: false, intervalMs: 10_000 })
  })

  it("refuses anything malformed", () => {
    expect(() => schedulerSettings({ ANONIFY_SCHEDULER: "yes" })).toThrow(
      /ANONIFY_SCHEDULER must be on or off/
    )
    for (const bad of ["9", "86401", "1.5", "often"]) {
      expect(() =>
        schedulerSettings({ ANONIFY_SCHEDULER_INTERVAL_SECONDS: bad })
      ).toThrow(/ANONIFY_SCHEDULER_INTERVAL_SECONDS/)
    }
  })
})

describe("the scheduler", () => {
  it("first ticks one interval after start, within ten per cent", async () => {
    vi.useFakeTimers()
    const sweep = vi.fn(async () => ({}))
    const scheduler = startScheduler({
      intervalMs: 1000,
      sweep,
      random: () => 0,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(899)
    expect(sweep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sweep).toHaveBeenCalledTimes(1)
    // Its purge budget is most of the interval.
    expect(sweep).toHaveBeenCalledWith(800)
    await scheduler.stop()
  })

  it("never waits more than ten per cent past the interval", async () => {
    vi.useFakeTimers()
    const sweep = vi.fn(async () => ({}))
    const scheduler = startScheduler({
      intervalMs: 1000,
      sweep,
      random: () => 1,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(1099)
    expect(sweep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sweep).toHaveBeenCalledTimes(1)
    await scheduler.stop()
  })

  it("does not start a tick while the last is running", async () => {
    let finish = () => {}
    const sweep = vi.fn(
      () =>
        new Promise<{ skipped?: string }>(
          (resolve) => (finish = () => resolve({}))
        )
    )
    const scheduler = startScheduler({
      intervalMs: 60_000,
      sweep,
      log: () => {},
    })
    const first = scheduler.tick()
    await scheduler.tick()
    expect(sweep).toHaveBeenCalledTimes(1)
    finish()
    await first
    await scheduler.stop()
  })

  it("logs only when it led, and records success either way", async () => {
    const logs: Record<string, unknown>[] = []
    let skipped: string | undefined = "another sweep is running"
    const scheduler = startScheduler({
      intervalMs: 60_000,
      sweep: async () => ({ skipped }),
      log: (fields) => logs.push(fields),
    })
    await scheduler.tick()
    expect(logs).toEqual([])
    expect(schedulerState().lastSuccessAt).toBeDefined()
    expect(schedulerState().lastLeaderAt).toBeUndefined()

    skipped = undefined
    await scheduler.tick()
    expect(logs).toEqual([{ leader: true, durationMs: expect.any(Number) }])
    expect(schedulerState().lastLeaderAt).toBeDefined()
    await scheduler.stop()
  })

  it("survives a failed sweep, and does not count it as a success", async () => {
    const logs: Record<string, unknown>[] = []
    const scheduler = startScheduler({
      intervalMs: 60_000,
      sweep: async () => {
        throw new Error("database unreachable")
      },
      log: (fields) => logs.push(fields),
    })
    await scheduler.tick()
    expect(logs[0]).toMatchObject({
      level: "error",
      message: "database unreachable",
    })
    expect(schedulerState().lastSuccessAt).toBeUndefined()
    await scheduler.stop()
  })

  it("stops: waits for the running sweep, and ticks no more", async () => {
    vi.useFakeTimers()
    let finish = () => {}
    let finished = false
    const sweep = vi.fn(
      () =>
        new Promise<{ skipped?: string }>((resolve) => {
          finish = () => {
            finished = true
            resolve({})
          }
        })
    )
    const scheduler = startScheduler({ intervalMs: 1000, sweep, log: () => {} })
    await vi.advanceTimersByTimeAsync(1100)
    expect(sweep).toHaveBeenCalledTimes(1)

    const stopped = scheduler.stop()
    let done = false
    void stopped.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toBe(false)
    finish()
    await stopped
    expect(finished).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(sweep).toHaveBeenCalledTimes(1)
  })
})
