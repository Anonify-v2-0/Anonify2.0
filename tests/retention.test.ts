import { describe, expect, it } from "vitest"

import { resolveExtension, retentionCeiling } from "@/lib/documents/retention"
import {
  extendableOptions,
  MAX_RETENTION_SECONDS,
  ttlLabel,
} from "@/types/document"

const HOUR = 3600 * 1000
const CREATED = new Date("2026-01-01T00:00:00.000Z")

function at(hoursAfterCreation: number): Date {
  return new Date(CREATED.getTime() + hoursAfterCreation * HOUR)
}

describe("retention labels", () => {
  it("describes a window as a duration, never as seconds", () => {
    expect(ttlLabel(3600)).toBe("1 hour")
    expect(ttlLabel(21600)).toBe("6 hours")
    expect(ttlLabel(86400)).toBe("24 hours")
    expect(ttlLabel(259200)).toBe("3 days")
  })

  it("falls back to a readable duration for an unlisted window", () => {
    expect(ttlLabel(7200)).toBe("2 hours")
    expect(ttlLabel(172800)).toBe("2 days")
  })
})

describe("extending a document", () => {
  it("extends from creation, not from now", () => {
    const decision = resolveExtension({
      createdAt: CREATED,
      currentExpiresAt: at(1),
      requestedTtlSeconds: 86400,
      now: at(0.5),
    })

    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    // 24 hours after creation — not 24 hours after the request.
    expect(decision.expiresAt.toISOString()).toBe(at(24).toISOString())
  })

  it("caps the window at 72 hours from creation", () => {
    expect(retentionCeiling(CREATED).toISOString()).toBe(at(72).toISOString())
    expect(MAX_RETENTION_SECONDS).toBe(72 * 3600)

    const decision = resolveExtension({
      createdAt: CREATED,
      currentExpiresAt: at(1),
      requestedTtlSeconds: 259200,
      now: at(0.5),
    })

    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.expiresAt.getTime()).toBeLessThanOrEqual(
      retentionCeiling(CREATED).getTime()
    )
  })

  it("cannot be walked forward by extending repeatedly", () => {
    let expiresAt = at(1)

    // Ask for the longest window over and over, hours apart.
    for (const hour of [2, 10, 30, 50, 70]) {
      const decision = resolveExtension({
        createdAt: CREATED,
        currentExpiresAt: expiresAt,
        requestedTtlSeconds: 259200,
        now: at(hour),
      })
      if (decision.ok) expiresAt = decision.expiresAt
    }

    // Every renewal converges on the same ceiling rather than moving it.
    expect(expiresAt.toISOString()).toBe(at(72).toISOString())
  })

  it("refuses once the document is already at the limit", () => {
    const decision = resolveExtension({
      createdAt: CREATED,
      currentExpiresAt: at(72),
      requestedTtlSeconds: 259200,
      now: at(10),
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toBe("already-at-limit")
  })

  it("refuses a window that would not extend anything", () => {
    const decision = resolveExtension({
      createdAt: CREATED,
      currentExpiresAt: at(24),
      requestedTtlSeconds: 3600,
      now: at(2),
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toBe("not-an-extension")
  })

  it("refuses a window that has already elapsed", () => {
    const decision = resolveExtension({
      createdAt: CREATED,
      currentExpiresAt: at(0.25),
      requestedTtlSeconds: 3600,
      now: at(2),
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toBe("would-expire-immediately")
  })

  it("refuses a window that is not one of the offered ones", () => {
    const decision = resolveExtension({
      createdAt: CREATED,
      currentExpiresAt: at(1),
      requestedTtlSeconds: 60 * 60 * 24 * 30,
      now: at(0.5),
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toBe("unsupported-window")
  })
})

describe("options offered to the user", () => {
  it("offers only windows that actually extend the document", () => {
    const options = extendableOptions(CREATED, at(24), at(2))
    expect(options.map((option) => option.value)).toEqual([259200])
  })

  it("offers nothing once the document is at the ceiling", () => {
    expect(extendableOptions(CREATED, at(72), at(10))).toEqual([])
  })

  it("does not offer a window that has already elapsed", () => {
    const options = extendableOptions(CREATED, at(0.25), at(2))
    expect(options.map((option) => option.value)).not.toContain(3600)
    expect(options.map((option) => option.value)).toContain(21600)
  })

  it("agrees with what the server would decide", () => {
    for (const option of extendableOptions(CREATED, at(1), at(0.5))) {
      const decision = resolveExtension({
        createdAt: CREATED,
        currentExpiresAt: at(1),
        requestedTtlSeconds: option.value,
        now: at(0.5),
      })
      expect(decision.ok).toBe(true)
      if (decision.ok) {
        expect(decision.expiresAt.toISOString()).toBe(
          option.expiresAt.toISOString()
        )
      }
    }
  })
})
