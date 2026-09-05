import { describe, expect, it } from "vitest"

import {
  decodesTo32Bytes,
  parseEnv,
  renderEnv,
  type EnvGroup,
} from "../scripts/env-file"

/**
 * The `.env` reader, tested because of what it decides.
 *
 * `pnpm setup` offers to reuse the secrets already in a `.env` rather than
 * generating new ones, and that offer is only as good as `parseEnv`. A line it
 * fails to recognise is a value it silently drops, and the one most likely to
 * be dropped is `ENCRYPTION_KEY` — which is not a password to be rotated:
 * documents are sealed with per-document keys wrapped by it, so replacing it
 * makes everything already stored permanently unreadable.
 *
 * So every shape a hand-edited file can plausibly have gets a case here, and
 * the assertion is always the same one: the value came back.
 */

const KEY = "a".repeat(64)

describe("reading an existing .env", () => {
  it.each([
    ["plain", `ENCRYPTION_KEY=${KEY}`],
    ["exported", `export ENCRYPTION_KEY=${KEY}`],
    ["double quoted", `ENCRYPTION_KEY="${KEY}"`],
    ["single quoted", `ENCRYPTION_KEY='${KEY}'`],
    ["spaced around the equals", `ENCRYPTION_KEY = ${KEY}`],
    ["indented", `   ENCRYPTION_KEY=${KEY}`],
    ["with a trailing carriage return", `ENCRYPTION_KEY=${KEY}\r`],
  ])("keeps a secret written %s", (_shape, line) => {
    expect(parseEnv(line).get("ENCRYPTION_KEY")).toBe(KEY)
  })

  it("skips commented lines, so a written default is not read back as a choice", () => {
    const values = parseEnv(
      ["# ANONIFY_QUOTA_UPLOADS=20", "ANONIFY_PROFILE=demo"].join("\n")
    )

    expect(values.has("ANONIFY_QUOTA_UPLOADS")).toBe(false)
    expect(values.get("ANONIFY_PROFILE")).toBe("demo")
  })

  it("keeps a value that contains an equals sign", () => {
    // Connection strings routinely do, and losing one silently sends somebody
    // back to a dashboard for a string they already had.
    const url = "postgresql://u:p@host/db?sslmode=require&channel_binding=require"
    expect(parseEnv(`DATABASE_URL=${url}`).get("DATABASE_URL")).toBe(url)
  })

  it("reads an empty value as empty rather than as absent", () => {
    const values = parseEnv("AI_MODEL=")
    expect(values.has("AI_MODEL")).toBe(true)
    expect(values.get("AI_MODEL")).toBe("")
  })

  it("ignores blank lines and anything that is not an assignment", () => {
    const values = parseEnv(["", "not a line", "  ", `A=1`].join("\n"))
    expect([...values.keys()]).toEqual(["A"])
  })
})

describe("whether a stored secret can still be used", () => {
  it("accepts the hex and base64 forms of 32 bytes", () => {
    expect(decodesTo32Bytes(KEY)).toBe(true)
    expect(decodesTo32Bytes(Buffer.alloc(32, 7).toString("base64"))).toBe(true)
  })

  it.each([
    ["blank", ""],
    ["truncated hex", "a".repeat(63)],
    ["16 bytes", Buffer.alloc(16).toString("base64")],
    ["not a key at all", "changeme"],
  ])("refuses %s rather than reusing a dud", (_shape, value) => {
    expect(decodesTo32Bytes(value)).toBe(false)
  })
})

describe("writing the file", () => {
  const groups: EnvGroup[] = [
    {
      heading: "Live",
      note: ["why this group exists"],
      lines: [{ key: "A", value: "1", comment: "what A is" }],
    },
    {
      heading: "Defaults",
      lines: [{ key: "B", value: "2", comment: "what B is", commented: true }],
    },
  ]

  const rendered = renderEnv("Test", groups)

  it("writes a default as an inert line that still states the default", () => {
    expect(rendered).toContain("# B=2")
    expect(rendered).toMatch(/# B=2\s+# what B is/)
    // Inert means inert: reading it back must not look like a choice.
    expect(parseEnv(rendered).has("B")).toBe(false)
  })

  it("explains a live value above it and a default beside it", () => {
    expect(rendered).toContain("# what A is\nA=1")
    expect(rendered).not.toContain("# what B is\n# B=2")
  })

  it("round-trips the values it wrote", () => {
    expect(parseEnv(rendered).get("A")).toBe("1")
  })

  it("drops a group with nothing in it rather than writing a bare heading", () => {
    expect(renderEnv("Test", [{ heading: "Empty", lines: [] }])).not.toContain(
      "Empty"
    )
  })
})
