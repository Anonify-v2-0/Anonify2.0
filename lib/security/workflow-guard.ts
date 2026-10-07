/**
 * Who may deliver a workflow step to this process (#179).
 *
 * The workflow world's runner executes each step by posting it to
 * `/.well-known/workflow/v1/{flow,step}` on this server. On Vercel the
 * platform's queue signs those deliveries. The Postgres world's do not carry
 * anything to check: the routes run whatever well-formed delivery arrives. So
 * anyone who could reach the server's port could post one, for example to
 * mark a step of a run they know as failed, or to replay a workflow.
 *
 * Nor is "it came from localhost" an answer. A reverse proxy on the same
 * machine, or a service mesh's sidecar, delivers every outside request over
 * loopback too.
 *
 * So the runner does not post to the server directly. instrumentation.ts
 * starts a relay on an ephemeral loopback port (lib/security/workflow-relay.ts)
 * and points the world at it with `WORKFLOW_LOCAL_BASE_URL`. The relay adds a
 * token minted for this process and forwards to the server, and proxy.ts
 * refuses a workflow route that does not carry it. Nobody outside the process
 * knows the token, and a process that started no relay (a web-only one, or
 * one where the worker failed to start) admits no deliveries at all.
 *
 * Kept on `globalThis`: instrumentation.ts and proxy.ts are separate bundles,
 * and the process is what they share (as lib/health/state.ts explains).
 */

export const RELAY_HEADER = "x-anonify-workflow-relay"

const shared = globalThis as unknown as { anonifyRelayToken?: string }

export function relayToken(): string | undefined {
  return shared.anonifyRelayToken
}

export function setRelayToken(token: string): void {
  shared.anonifyRelayToken = token
}

/** Whether a request came through this process's own relay. */
export function cameThroughRelay(headers: Headers): boolean {
  const token = relayToken()
  const presented = headers.get(RELAY_HEADER)
  if (!token || !presented) return false
  return sameString(token, presented)
}

/** Compares without stopping at the first difference. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

/**
 * Whether the workflow routes are this process's to guard: wherever a world
 * of our own is configured. Unset on Vercel, whose queue signs deliveries.
 */
export function guardsWorkflowRoutes(
  env: Record<string, string | undefined> = process.env
): boolean {
  return Boolean(env.WORKFLOW_TARGET_WORLD?.trim())
}
