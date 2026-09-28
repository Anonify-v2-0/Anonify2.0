import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The session cookie rolls.
 *
 * A global rule is kept for 30 days after its last use, and the cookie is the
 * only thing that reaches it, so the requests that use one renew the cookie
 * for 30 days too. A cookie that expired 30 days after the first visit, however
 * busy the reviewer was, took every rule with it on that day.
 */

const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  writes: [] as { name: string; value: string; maxAge?: number }[],
}))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.values.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: (name: string, value: string, options: { maxAge?: number }) => {
      jar.writes.push({ name, value, maxAge: options.maxAge })
      jar.values.set(name, value)
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
}))

process.env.FINGERPRINT_SECRET ??= "test-fingerprint-secret"

const { getIdentity, peekIdentity, renewIdentity, SESSION_COOKIE } =
  await import("@/lib/security/fingerprint")

const THIRTY_DAYS = 60 * 60 * 24 * 30
const EXISTING = "a".repeat(48)

beforeEach(() => {
  jar.values.clear()
  jar.writes = []
})

describe("session cookie", () => {
  it("renews an existing session on every getIdentity, keeping its id", async () => {
    jar.values.set(SESSION_COOKIE, EXISTING)

    const identity = await getIdentity()

    expect(identity.sessionId).toBe(EXISTING)
    expect(jar.writes).toEqual([
      { name: SESSION_COOKIE, value: EXISTING, maxAge: THIRTY_DAYS },
    ])
  })

  it("issues a session when there is none", async () => {
    const identity = await getIdentity()

    expect(identity.sessionId).toHaveLength(48)
    expect(jar.writes).toEqual([
      { name: SESSION_COOKIE, value: identity.sessionId, maxAge: THIRTY_DAYS },
    ])
  })

  it("renews without issuing: no session stays no session", async () => {
    expect(await renewIdentity()).toBeNull()
    expect(jar.writes).toEqual([])

    jar.values.set(SESSION_COOKIE, EXISTING)
    expect((await renewIdentity())?.sessionId).toBe(EXISTING)
    expect(jar.writes).toEqual([
      { name: SESSION_COOKIE, value: EXISTING, maxAge: THIRTY_DAYS },
    ])
  })

  it("never writes from peekIdentity, which pages call", async () => {
    jar.values.set(SESSION_COOKIE, EXISTING)

    expect((await peekIdentity())?.sessionId).toBe(EXISTING)
    expect(jar.writes).toEqual([])
  })
})
