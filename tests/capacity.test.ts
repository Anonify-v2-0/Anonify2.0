import { afterEach, describe, expect, it } from "vitest"

import {
  applyJobConcurrency,
  cgroupCpuLimit,
  cpuConcurrency,
  jobConcurrency,
  workflowPoolDefault,
  type CpuProbe,
} from "@/lib/runtime/capacity"
import {
  cpuSlotState,
  resetCpuSlots,
  Semaphore,
  withCpuSlot,
} from "@/lib/runtime/cpu-slots"

/**
 * What one process may take on at once (#181): its CPU slots, its job
 * concurrency, and the semaphore that holds the first.
 */

function probe(
  available: number,
  files: Record<string, string> = {}
): CpuProbe {
  return { available: () => available, read: (path) => files[path] }
}

describe("the CPUs a process may use", () => {
  it("reads a cgroup v2 quota in whole CPUs, rounding down as libuv does", () => {
    expect(
      cgroupCpuLimit((p) =>
        p === "/sys/fs/cgroup/cpu.max" ? "150000 100000\n" : undefined
      )
    ).toBe(1)
    expect(
      cgroupCpuLimit((p) =>
        p === "/sys/fs/cgroup/cpu.max" ? "250000 100000" : undefined
      )
    ).toBe(2)
    expect(
      cgroupCpuLimit((p) =>
        p === "/sys/fs/cgroup/cpu.max" ? "50000 100000" : undefined
      )
    ).toBe(1)
    expect(
      cgroupCpuLimit((p) =>
        p === "/sys/fs/cgroup/cpu.max" ? "max 100000" : undefined
      )
    ).toBeUndefined()
  })

  it("reads a cgroup v1 quota, and treats -1 as none", () => {
    const v1 = (quota: string) => (path: string) =>
      ({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": quota,
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
      })[path]
    expect(cgroupCpuLimit(v1("400000"))).toBe(4)
    expect(cgroupCpuLimit(v1("-1"))).toBeUndefined()
  })

  it("has no quota off Linux", () => {
    expect(cgroupCpuLimit(() => undefined)).toBeUndefined()
  })

  it("takes the smaller of the schedulable CPUs and the quota", () => {
    const quota = { "/sys/fs/cgroup/cpu.max": "200000 100000" }
    expect(cpuConcurrency({}, probe(16, quota))).toBe(2)
    expect(cpuConcurrency({}, probe(1, quota))).toBe(1)
    expect(cpuConcurrency({}, probe(8))).toBe(8)
    expect(cpuConcurrency({}, probe(0))).toBe(1)
    expect(cpuConcurrency({}, probe(256))).toBe(64)
  })

  it("lets ANONIFY_CPU_CONCURRENCY decide, and refuses a malformed one", () => {
    expect(cpuConcurrency({ ANONIFY_CPU_CONCURRENCY: "3" }, probe(16))).toBe(3)
    for (const bad of ["0", "65", "1.5", "two"]) {
      expect(() =>
        cpuConcurrency({ ANONIFY_CPU_CONCURRENCY: bad }, probe(4))
      ).toThrow(/ANONIFY_CPU_CONCURRENCY must be a whole number from 1 to 64/)
    }
  })
})

describe("the jobs a process runs at once", () => {
  it("defaults from the role and the CPUs", () => {
    expect(jobConcurrency({ ANONIFY_ROLE: "worker" }, probe(4))).toBe(8)
    expect(jobConcurrency({}, probe(4))).toBe(6)
    expect(jobConcurrency({ ANONIFY_ROLE: "web" }, probe(4))).toBe(6)
    expect(jobConcurrency({ ANONIFY_ROLE: "worker" }, probe(64))).toBe(64)
  })

  it("follows ANONIFY_CPU_CONCURRENCY", () => {
    expect(
      jobConcurrency(
        { ANONIFY_ROLE: "worker", ANONIFY_CPU_CONCURRENCY: "1" },
        probe(16)
      )
    ).toBe(2)
  })

  it("lets an explicit WORKFLOW_POSTGRES_WORKER_CONCURRENCY win", () => {
    expect(
      jobConcurrency(
        { ANONIFY_ROLE: "worker", WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "20" },
        probe(2)
      )
    ).toBe(20)
    expect(() =>
      jobConcurrency({ WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "0" }, probe(2))
    ).toThrow(/WORKFLOW_POSTGRES_WORKER_CONCURRENCY/)
  })

  it("is written back where the workflow world reads it", () => {
    const env: Record<string, string | undefined> = {
      ANONIFY_ROLE: "worker",
      ANONIFY_CPU_CONCURRENCY: "3",
    }
    expect(applyJobConcurrency(env)).toBe(6)
    expect(env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY).toBe("6")
  })

  it("sizes the world's pool for the role", () => {
    expect(workflowPoolDefault({}, probe(2))).toBeUndefined()
    expect(workflowPoolDefault({}, probe(16))).toBe(20)
    expect(workflowPoolDefault({ ANONIFY_ROLE: "web" }, probe(16))).toBe(4)
    expect(workflowPoolDefault({ ANONIFY_ROLE: "worker" }, probe(4))).toBe(10)
    expect(
      workflowPoolDefault(
        { ANONIFY_ROLE: "worker", WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "20" },
        probe(4)
      )
    ).toBe(22)
  })
})

describe("the CPU semaphore", () => {
  afterEach(() => resetCpuSlots())

  it("serves waiters first come, first served", async () => {
    const semaphore = new Semaphore(1)
    const order: number[] = []
    const hold = await semaphore.acquire()
    const waiters = [1, 2, 3].map((n) =>
      semaphore.run(async () => {
        order.push(n)
      })
    )
    expect(semaphore.state).toEqual({ inUse: 1, waiting: 3, slots: 1 })
    hold()
    await Promise.all(waiters)
    expect(order).toEqual([1, 2, 3])
    expect(semaphore.state).toEqual({ inUse: 0, waiting: 0, slots: 1 })
  })

  it("never lets a newcomer overtake somebody waiting", async () => {
    const semaphore = new Semaphore(1)
    const order: string[] = []
    const hold = await semaphore.acquire()
    const first = semaphore.run(() => {
      order.push("waiting")
    })
    hold()
    // Arrives after the release, before the waiter has run.
    const second = semaphore.run(() => {
      order.push("newcomer")
    })
    await Promise.all([first, second])
    expect(order).toEqual(["waiting", "newcomer"])
  })

  it("gives the slot back when the work throws", async () => {
    const semaphore = new Semaphore(2)
    await expect(
      semaphore.run(async () => {
        throw new Error("render failed")
      })
    ).rejects.toThrow("render failed")
    expect(semaphore.state.inUse).toBe(0)
  })

  it("releases once, however often release is called", async () => {
    const semaphore = new Semaphore(1)
    const release = await semaphore.acquire()
    const waiter = semaphore.acquire()
    release()
    release()
    const second = await waiter
    expect(semaphore.state).toEqual({ inUse: 1, waiting: 0, slots: 1 })
    second()
    expect(semaphore.state.inUse).toBe(0)
  })

  it("never runs more than its slots at once", async () => {
    resetCpuSlots(2)
    let running = 0
    let most = 0
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withCpuSlot(async () => {
          running += 1
          most = Math.max(most, running)
          await new Promise((resolve) => setTimeout(resolve, 2))
          running -= 1
        })
      )
    )
    expect(most).toBe(2)
    expect(cpuSlotState()).toEqual({ inUse: 0, waiting: 0, slots: 2 })
  })

  it("is re-entrant, so nested work cannot wait for itself", async () => {
    resetCpuSlots(1)
    const result = await withCpuSlot(() =>
      withCpuSlot(() => withCpuSlot(async () => "drawn"))
    )
    expect(result).toBe("drawn")
    expect(cpuSlotState().inUse).toBe(0)
  })

  it("does not count work a slot started and left running as holding it", async () => {
    resetCpuSlots(1)
    let leftRunning: Promise<void> = Promise.resolve()
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let inner = false

    await withCpuSlot(async () => {
      leftRunning = gate.then(() =>
        withCpuSlot(async () => {
          inner = cpuSlotState().inUse === 1
        })
      )
    })
    release()
    await leftRunning
    // It took a slot of its own rather than running unaccounted.
    expect(inner).toBe(true)
  })
})
