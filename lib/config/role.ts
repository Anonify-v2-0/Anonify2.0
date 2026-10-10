/**
 * What this process is for: serving people, processing documents, or both
 * (#179).
 *
 * Every process used to be both. The workflow world's runner started in each
 * one and executed steps by posting back to the same server, so rasterising a
 * burst of scanned PDFs ran on the event loop that also served the UI, the
 * progress streams and the health check. `ANONIFY_ROLE` splits them:
 *
 * - `all` (the default): both, exactly as before.
 * - `web`: serves the app and the API. Starting a run only inserts a job, so a
 *   web process still accepts documents; it never executes a step.
 * - `worker`: runs the job queue. It still runs the Next server, because the
 *   runner delivers each step to `/.well-known/workflow/v1/*` on localhost,
 *   but it answers 404 to everything else (see proxy.ts) and should have no
 *   ingress.
 */

export const ROLES = ["all", "web", "worker"] as const

export type AnonifyRole = (typeof ROLES)[number]

type Env = Record<string, string | undefined>

export function anonifyRole(env: Env = process.env): AnonifyRole {
  const raw = env.ANONIFY_ROLE?.trim().toLowerCase()
  if (!raw) return "all"
  if (!(ROLES as readonly string[]).includes(raw)) {
    throw new Error(
      `ANONIFY_ROLE must be one of ${ROLES.join(", ")}, got "${env.ANONIFY_ROLE}"`
    )
  }
  return raw as AnonifyRole
}

/** Whether this process starts the workflow world's runner. */
export function runsWorker(env: Env = process.env): boolean {
  return anonifyRole(env) !== "web"
}

/** Whether this process serves the app and the API to people. */
export function servesTraffic(env: Env = process.env): boolean {
  return anonifyRole(env) !== "worker"
}

/**
 * A split deployment is several machines by definition, and the local
 * storage driver is one machine's disk: an upload accepted by a web process
 * would be invisible to the worker that processes it. Refused at start, with
 * the reason, rather than failing on the first document.
 */
export function assertRoleStorage(
  storageDriver: string,
  env: Env = process.env
): void {
  const role = anonifyRole(env)
  if (role !== "all" && storageDriver === "local") {
    throw new Error(
      `ANONIFY_ROLE=${role} needs shared storage, and the configured storage is the local disk, which each process sees on its own. Set STORAGE_DRIVER to s3 or vercel-blob. See docs/storage.md.`
    )
  }
}
