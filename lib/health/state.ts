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
 * - `markClosing`, from the same handler once the workers have drained: the
 *   HTTP server is about to close, and long-lived responses (progress
 *   streams) end themselves so their clients reconnect elsewhere.
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
  closing: boolean
}

const shared = globalThis as unknown as {
  anonifyHealth?: HealthState
  anonifyClosingListeners?: Set<() => void>
}

function fresh(): HealthState {
  return {
    startedAt: new Date(),
    worldStarted: false,
    draining: false,
    closing: false,
  }
}

function state(): HealthState {
  shared.anonifyHealth ??= fresh()
  return shared.anonifyHealth
}

function closingListeners(): Set<() => void> {
  shared.anonifyClosingListeners ??= new Set()
  return shared.anonifyClosingListeners
}

export function markWorldStarted(): void {
  state().worldStarted = true
}

export function markDraining(): void {
  state().draining = true
}

/** The HTTP server is about to close: tells every `onClosing` listener, once. */
export function markClosing(): void {
  if (state().closing) return
  state().closing = true
  for (const listener of [...closingListeners()]) {
    try {
      listener()
    } catch {
      // One stream failing to end must not stop the others.
    }
  }
}

/**
 * Calls `listener` when the server starts closing, at once if it already
 * has. Returns the unsubscribe.
 */
export function onClosing(listener: () => void): () => void {
  if (state().closing) {
    listener()
    return () => {}
  }
  closingListeners().add(listener)
  return () => closingListeners().delete(listener)
}

export function healthState(): Readonly<HealthState> {
  return state()
}

/** For tests: back to a freshly started process. */
export function resetHealthState(): void {
  shared.anonifyHealth = fresh()
  shared.anonifyClosingListeners = new Set()
}
