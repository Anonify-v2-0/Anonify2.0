/**
 * Polling that stops when nobody is looking.
 *
 * The document list and the batch view refresh themselves while a document is
 * processing. Before this, a tab left open in the background kept asking every
 * four seconds for as long as anything was in flight, which for a document
 * queued behind the quota could be all night.
 *
 * - **Active and visible:** one request every `intervalMs`, as before, so a
 *   document in flight updates as quickly as it did.
 * - **Hidden:** nothing is scheduled.
 * - **Visible again:** one request straight away, whether or not anything was
 *   in flight, so a change made in another tab shows up on return, and then
 *   the loop again if there is still work.
 * - **Nothing in flight:** nothing is scheduled.
 *
 * One request at a time: a tick that comes round while the last one is still
 * out is skipped rather than stacked.
 *
 * Kept free of React so the timing can be tested with fake timers; see
 * `hooks/use-polling.ts` for the hook.
 */

export type Visibility = {
  hidden(): boolean
  /** Subscribes to changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

export type Poller = {
  setActive(active: boolean): void
  stop(): void
}

export function createPoller({
  poll,
  intervalMs,
  visibility,
}: {
  poll: () => Promise<void>
  intervalMs: number
  visibility: Visibility
}): Poller {
  let active = false
  let stopped = false
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function clear() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function schedule() {
    clear()
    if (stopped || !active || visibility.hidden()) return
    timer = setTimeout(tick, intervalMs)
  }

  async function tick() {
    timer = undefined
    if (stopped || inFlight) return
    inFlight = true
    try {
      await poll()
    } catch {
      // A transient failure just means the next tick tries again.
    } finally {
      inFlight = false
    }
    schedule()
  }

  const unsubscribe = visibility.subscribe(() => {
    if (stopped) return
    if (visibility.hidden()) {
      clear()
      return
    }
    clear()
    void tick()
  })

  return {
    setActive(next) {
      if (next === active) return
      active = next
      if (active) {
        if (timer === undefined && !inFlight) schedule()
      } else {
        clear()
      }
    },
    stop() {
      stopped = true
      clear()
      unsubscribe()
    },
  }
}

/** The page's own visibility, for the browser. */
export function documentVisibility(): Visibility {
  return {
    hidden: () => document.visibilityState === "hidden",
    subscribe(listener) {
      document.addEventListener("visibilitychange", listener)
      return () => document.removeEventListener("visibilitychange", listener)
    },
  }
}

/**
 * A GET that sends back the tag of the last answer it saw.
 *
 * Resolves to the parsed body when it changed, and to `null` when the server
 * answered 304 or failed: either way there is nothing new to draw.
 */
export function conditionalFetcher<T>(): (url: string) => Promise<T | null> {
  let etag: string | null = null

  return async (url) => {
    const response = await fetch(url, {
      cache: "no-store",
      headers: etag ? { "if-none-match": etag } : undefined,
    })
    if (response.status === 304 || !response.ok) return null
    etag = response.headers.get("etag")
    return (await response.json()) as T
  }
}
