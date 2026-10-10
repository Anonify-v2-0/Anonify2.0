import { readFileSync } from "node:fs"
import os from "node:os"

import { anonifyRole } from "@/lib/config/role"

/**
 * What one process may take on at once (#181).
 *
 * Horizontal scaling works only if one replica has a known ceiling: N
 * replicas are then N times the capacity, and a replica never takes on more
 * than its CPU and memory can hold. Admission bounds one *owner's* documents,
 * so ten owners meant sixty runs admitted at once, and the one per-process
 * limit, the world's job concurrency, defaulted to 10 whether the process had
 * one CPU or sixteen. The numbers live here, together, derived from the CPUs
 * this process can actually use.
 *
 * - `cpuConcurrency()`: CPU-bound sections (page rendering, OCR, image work)
 *   running at once, through lib/runtime/cpu-slots.ts.
 * - `jobConcurrency()`: workflow steps one process runs at once, written back
 *   to `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` before the world reads it.
 *
 * A malformed value stops the server at start: a limit that looks set and is
 * not in force is worse than no limit.
 */

type Env = Record<string, string | undefined>

export const CPU_CONCURRENCY_ENV = "ANONIFY_CPU_CONCURRENCY"
export const JOB_CONCURRENCY_ENV = "WORKFLOW_POSTGRES_WORKER_CONCURRENCY"

/** The bounds a derived or configured CPU concurrency is held to. */
export const MAX_CPU_CONCURRENCY = 64
/** A derived job concurrency is held to this; an explicit one to 100, as before. */
export const MAX_DERIVED_JOB_CONCURRENCY = 64
const MAX_EXPLICIT_JOB_CONCURRENCY = 100

function wholeNumber(
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

/** Reads a file, or nothing: cgroup files are absent off Linux. */
export type ReadFile = (path: string) => string | undefined

const readIfPresent: ReadFile = (path) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * The whole CPUs a container's quota allows, at least one, or undefined for
 * none.
 *
 * `os.availableParallelism()` counts the CPUs the process may be scheduled on.
 * Node 22's libuv also honours a CPU *quota* (`docker run --cpus`, a
 * Kubernetes limit, a task's vCPUs), rounding down: measured in the image,
 * `--cpus=1.5` answers 1 on 16 CPUs. Older runtimes did not, and the image's
 * base moves, so the quota is read here too, rounded the same way, and the
 * smaller answer wins. cgroup v2 first (`cpu.max`), then v1.
 */
export function cgroupCpuLimit(
  read: ReadFile = readIfPresent
): number | undefined {
  const v2 = read("/sys/fs/cgroup/cpu.max")?.trim()
  if (v2) {
    const [quota, period] = v2.split(/\s+/)
    if (quota === "max") return undefined
    return quotaToCpus(Number(quota), Number(period))
  }

  for (const directory of [
    "/sys/fs/cgroup/cpu",
    "/sys/fs/cgroup/cpu,cpuacct",
  ]) {
    const quota = read(`${directory}/cpu.cfs_quota_us`)?.trim()
    const period = read(`${directory}/cpu.cfs_period_us`)?.trim()
    if (quota === undefined || period === undefined) continue
    return quotaToCpus(Number(quota), Number(period))
  }
  return undefined
}

function quotaToCpus(quota: number, period: number): number | undefined {
  // -1 is v1's "no quota"; anything unreadable is treated the same way.
  if (!Number.isFinite(quota) || !Number.isFinite(period)) return undefined
  if (quota <= 0 || period <= 0) return undefined
  return Math.max(1, Math.floor(quota / period))
}

export type CpuProbe = {
  available: () => number
  read: ReadFile
}

const systemProbe: CpuProbe = {
  available: () => os.availableParallelism(),
  read: readIfPresent,
}

/**
 * CPU-bound sections this process runs at once: `ANONIFY_CPU_CONCURRENCY`
 * (1–64), else the CPUs it can use, quota included.
 */
export function cpuConcurrency(
  env: Env = process.env,
  probe: CpuProbe = systemProbe
): number {
  const configured = wholeNumber(
    env,
    CPU_CONCURRENCY_ENV,
    1,
    MAX_CPU_CONCURRENCY
  )
  if (configured !== undefined) return configured

  const available = Math.max(1, probe.available())
  const quota = cgroupCpuLimit(probe.read)
  return Math.min(
    MAX_CPU_CONCURRENCY,
    quota ? Math.min(available, quota) : available
  )
}

/**
 * Workflow steps this process runs at once.
 *
 * `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` (1–100) when set. Otherwise from the
 * role: a dedicated worker runs twice its CPUs, because a step is as often
 * waiting on a model provider as rendering a page; a process that also serves
 * people runs its CPUs plus two, leaving room for the requests. A web process
 * runs no steps, and gets the `all` figure for sizing its streaming budget.
 */
export function jobConcurrency(
  env: Env = process.env,
  probe: CpuProbe = systemProbe
): number {
  const configured = wholeNumber(
    env,
    JOB_CONCURRENCY_ENV,
    1,
    MAX_EXPLICIT_JOB_CONCURRENCY
  )
  if (configured !== undefined) return configured

  const cpus = cpuConcurrency(env, probe)
  const derived = anonifyRole(env) === "worker" ? 2 * cpus : cpus + 2
  return Math.min(MAX_DERIVED_JOB_CONCURRENCY, derived)
}

/**
 * Puts the job concurrency in force: the workflow world reads
 * `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` once, when it is created, and
 * defaults to 10 without it. Called from instrumentation.ts before anything
 * calls `getWorld()`. Returns the value.
 */
export function applyJobConcurrency(env: Env = process.env): number {
  const jobs = jobConcurrency(env)
  env[JOB_CONCURRENCY_ENV] = String(jobs)
  return jobs
}

/** The world's own default for its pool when nobody sets one. */
const WORLD_DEFAULT_POOL = 10

/**
 * The workflow world's pool, sized for the role when nobody has set it.
 *
 * A web process only enqueues jobs and reads run streams, so it needs few
 * connections. A process that runs steps holds one per running job, plus two
 * for the queue's own bookkeeping; `all` keeps the world's default of 10
 * unless its jobs need more. An explicit `WORKFLOW_POSTGRES_MAX_POOL_SIZE`
 * always wins. See docs/deploy/database.md.
 */
export function workflowPoolDefault(
  env: Env = process.env,
  probe: CpuProbe = systemProbe
): number | undefined {
  switch (anonifyRole(env)) {
    case "web":
      return 4
    case "worker":
      return jobConcurrency(env, probe) + 2
    default: {
      const needed = jobConcurrency(env, probe) + 2
      return needed > WORLD_DEFAULT_POOL ? needed : undefined
    }
  }
}

/** Both numbers, for the start-up log line. */
export function capacitySummary(env: Env = process.env) {
  return {
    cpuConcurrency: cpuConcurrency(env),
    jobConcurrency: jobConcurrency(env),
  }
}
