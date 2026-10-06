/**
 * What this process knows about its own health, for /api/health and
 * /api/ready (#167).
 *
 * Process-local on purpose: a replica answers for itself. Two setters, and
 * the callers that own them:
 *
 * - `markWorldStarted`, from instrumentation.ts, once the workflow world's
 *   worker has started. Until then a replica meant to process documents
 *   would accept them and never run them.
 * - `markDraining`, from the shutdown handler (#182), so a replica that is
 *   going away stops being routed to before it stops answering.
 *
 * Kept on `globalThis`, not in a module variable. Next.js bundles
 * instrumentation.ts and the route handlers separately, so each gets its own
 * copy of this module: a flag set by one was never seen by the other, and a
 * replica whose worker had started reported that it had not. The process is
 * the one thing they share, as lib/database/prisma.ts relies on too.
 */

type HealthState = {
  startedAt: Date
  worldStarted: boolean
  draining: boolean
}

const shared = globalThis as unknown as { anonifyHealth?: HealthState }

function state(): HealthState {
  shared.anonifyHealth ??= {
    startedAt: new Date(),
    worldStarted: false,
    draining: false,
  }
  return shared.anonifyHealth
}

export function markWorldStarted(): void {
  state().worldStarted = true
}

export function markDraining(): void {
  state().draining = true
}

export function healthState(): Readonly<HealthState> {
  return state()
}

/** For tests: back to a freshly started process. */
export function resetHealthState(): void {
  shared.anonifyHealth = {
    startedAt: new Date(),
    worldStarted: false,
    draining: false,
  }
}
