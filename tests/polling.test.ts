import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { conditionalJsonResponse } from "@/lib/api/etag"
import { createPoller, type Visibility } from "@/lib/api/poller"

/**
 * The document list and the batch view poll while something is processing,
 * and stop when nobody can see them (#177).
 */

function fakeVisibility(initiallyHidden = false) {
  let hidden = initiallyHidden
  const listeners = new Set<() => void>()
  const visibility: Visibility = {
    hidden: () => hidden,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    visibility,
    listeners,
    set(next: boolean) {
      hidden = next
      for (const listener of listeners) listener()
    },
  }
}

describe("createPoller", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("polls every interval while active and visible", async () => {
    const poll = vi.fn(async () => {})
    const { visibility } = fakeVisibility()
    const poller = createPoller({ poll, intervalMs: 4000, visibility })

    poller.setActive(true)
    expect(poll).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(4000)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000 * 5)
    expect(poll).toHaveBeenCalledTimes(6)

    poller.stop()
  })

  it("does not poll while nothing is in flight", async () => {
    const poll = vi.fn(async () => {})
    const { visibility } = fakeVisibility()
    const poller = createPoller({ poll, intervalMs: 4000, visibility })

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(poll).not.toHaveBeenCalled()

    poller.setActive(true)
    await vi.advanceTimersByTimeAsync(4000)
    poller.setActive(false)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(poll).toHaveBeenCalledTimes(1)

    poller.stop()
  })

  it("stops while the tab is hidden, and polls at once when it is back", async () => {
    const poll = vi.fn(async () => {})
    const tab = fakeVisibility()
    const poller = createPoller({
      poll,
      intervalMs: 4000,
      visibility: tab.visibility,
    })

    poller.setActive(true)
    await vi.advanceTimersByTimeAsync(4000)
    expect(poll).toHaveBeenCalledTimes(1)

    tab.set(true)
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000)
    expect(poll).toHaveBeenCalledTimes(1)

    tab.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(2)

    // And the loop carries on from there.
    await vi.advanceTimersByTimeAsync(4000)
    expect(poll).toHaveBeenCalledTimes(3)

    poller.stop()
  })

  it("refreshes once on return even with nothing in flight, then stays quiet", async () => {
    const poll = vi.fn(async () => {})
    const tab = fakeVisibility(true)
    const poller = createPoller({
      poll,
      intervalMs: 4000,
      visibility: tab.visibility,
    })

    // Becoming active while hidden schedules nothing.
    poller.setActive(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(poll).not.toHaveBeenCalled()
    poller.setActive(false)

    tab.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(poll).toHaveBeenCalledTimes(1)

    poller.stop()
  })

  it("never has two requests out at once", async () => {
    let inFlight = 0
    let most = 0
    const poll = vi.fn(async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10_000))
      inFlight--
    })
    const tab = fakeVisibility()
    const poller = createPoller({
      poll,
      intervalMs: 4000,
      visibility: tab.visibility,
    })

    poller.setActive(true)
    await vi.advanceTimersByTimeAsync(4000)
    // Flicker the tab while the slow request is out.
    tab.set(true)
    tab.set(false)
    tab.set(true)
    tab.set(false)
    poller.setActive(false)
    poller.setActive(true)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(most).toBe(1)
    poller.stop()
  })

  it("keeps polling after a failed request", async () => {
    const poll = vi.fn(async () => {
      throw new Error("offline")
    })
    const { visibility } = fakeVisibility()
    const poller = createPoller({ poll, intervalMs: 4000, visibility })

    poller.setActive(true)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(poll).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it("does nothing once stopped", async () => {
    const poll = vi.fn(async () => {})
    const tab = fakeVisibility()
    const poller = createPoller({
      poll,
      intervalMs: 4000,
      visibility: tab.visibility,
    })

    poller.setActive(true)
    poller.stop()
    tab.set(true)
    tab.set(false)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(poll).not.toHaveBeenCalled()
    expect(tab.listeners.size).toBe(0)
  })
})

describe("conditionalJsonResponse", () => {
  const body = { documents: [{ id: "a", status: "queued" }] }

  function get(ifNoneMatch?: string) {
    return new Request("http://localhost/api/documents", {
      headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
    })
  }

  it("answers 200 with a weak tag, and 304 with no body for the same tag", async () => {
    const first = conditionalJsonResponse(get(), body)
    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toBe("no-store")
    const tag = first.headers.get("etag")!
    expect(tag).toMatch(/^W\/"[\w-]+"$/)
    expect(await first.json()).toEqual(body)

    const again = conditionalJsonResponse(get(tag), body)
    expect(again.status).toBe(304)
    expect(again.headers.get("etag")).toBe(tag)
    expect(await again.text()).toBe("")
  })

  it("answers 200 with a new tag when anything changed", () => {
    const tag = conditionalJsonResponse(get(), body).headers.get("etag")!
    const changed = {
      documents: [{ id: "a", status: "ready" }],
    }
    const response = conditionalJsonResponse(get(tag), changed)
    expect(response.status).toBe(200)
    expect(response.headers.get("etag")).not.toBe(tag)
  })

  it("compares weakly and reads a list of tags", () => {
    const tag = conditionalJsonResponse(get(), body).headers.get("etag")!
    const strong = tag.slice(2)
    expect(conditionalJsonResponse(get(strong), body).status).toBe(304)
    expect(conditionalJsonResponse(get(`W/"other", ${tag}`), body).status).toBe(
      304
    )
    expect(conditionalJsonResponse(get("*"), body).status).toBe(304)
    expect(conditionalJsonResponse(get(`W/"other"`), body).status).toBe(200)
  })
})
