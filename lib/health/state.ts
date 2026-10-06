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
 */

type HealthState = {
  startedAt: Date
  worldStarted: boolean
  draining: boolean
}

const state: HealthState = {
  startedAt: new Date(),
  worldStarted: false,
  draining: false,
}

export function markWorldStarted(): void {
  state.worldStarted = true
}

export function markDraining(): void {
  state.draining = true
}

export function healthState(): Readonly<HealthState> {
  return state
}

/** For tests: back to a freshly started process. */
export function resetHealthState(): void {
  state.startedAt = new Date()
  state.worldStarted = false
  state.draining = false
}
