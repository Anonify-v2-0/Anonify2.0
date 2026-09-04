/**
 * Token bucket maths, kept separate from storage so it can be reasoned about
 * and tested without a database.
 *
 * A fixed window lets a caller spend a full allowance at the end of one window
 * and another immediately at the start of the next — twice the intended rate,
 * back to back, right on the boundary. A bucket refills continuously, so there
 * is no boundary to exploit: the long-run rate is the refill rate, and `burst`
 * says exactly how much may arrive at once.
 */

export type BucketConfig = {
  /** Maximum tokens the bucket can hold — the largest permitted burst. */
  burst: number
  /** Tokens added per second — the sustained rate. */
  refillPerSecond: number
}

export type BucketState = {
  tokens: number
  updatedAt: Date
}

export type BucketDecision = {
  allowed: boolean
  /** Tokens left after this request. */
  remaining: number
  state: BucketState
  /** When a caller who was refused could next succeed. */
  retryAfterMs: number
}

/** Refills the bucket for the time that has passed, capped at `burst`. */
export function refill(
  state: BucketState,
  config: BucketConfig,
  now: Date
): number {
  const elapsedSeconds = Math.max(
    0,
    (now.getTime() - state.updatedAt.getTime()) / 1000
  )
  return Math.min(
    config.burst,
    state.tokens + elapsedSeconds * config.refillPerSecond
  )
}

/**
 * Takes one token if the bucket has one. The returned state is what should be
 * persisted — including on refusal, so the refill clock keeps advancing.
 */
export function consume(
  state: BucketState,
  config: BucketConfig,
  now: Date
): BucketDecision {
  const available = refill(state, config, now)

  if (available < 1) {
    const shortfall = 1 - available
    return {
      allowed: false,
      remaining: 0,
      state: { tokens: available, updatedAt: now },
      retryAfterMs: Math.ceil((shortfall / config.refillPerSecond) * 1000),
    }
  }

  const tokens = available - 1
  return {
    allowed: true,
    remaining: Math.floor(tokens),
    state: { tokens, updatedAt: now },
    retryAfterMs: 0,
  }
}

/** A bucket that has never been seen starts full. */
export function freshState(config: BucketConfig, now: Date): BucketState {
  return { tokens: config.burst, updatedAt: now }
}

/**
 * Expresses the old "N requests per window" configuration as a bucket: the
 * window's allowance becomes the burst, spread evenly across the window.
 */
export function bucketFor(limit: number, windowSeconds: number): BucketConfig {
  return { burst: limit, refillPerSecond: limit / windowSeconds }
}
