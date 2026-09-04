import { afterEach, describe, expect, it } from "vitest"

import {
  defaultsFor,
  effectiveQuotas,
  envName,
  envOverrides,
  isUnlimited,
  resolveQuotas,
  USAGE_KINDS,
} from "@/lib/security/quota-config"

afterEach(() => {
  delete process.env.ANONIFY_PROFILE
  for (const kind of USAGE_KINDS) delete process.env[envName(kind)]
})

describe("quota defaults", () => {
  it("does not ration a self-hosted install", () => {
    // The bug this replaces: an ordinary 800-row spreadsheet failed to process
    // on someone's own machine because a shared demo could not have afforded
    // it. The demo's allowances are a property of the demo.
    const local = defaultsFor("self-hosted")
    for (const kind of USAGE_KINDS) expect(isUnlimited(local[kind])).toBe(true)
  })

  it("keeps the demo's allowances finite", () => {
    const demo = defaultsFor("demo")
    for (const kind of USAGE_KINDS) expect(demo[kind]).toBeGreaterThan(0)
  })

  it("follows the profile", () => {
    expect(isUnlimited(effectiveQuotas().xlsxCells)).toBe(true)

    process.env.ANONIFY_PROFILE = "demo"
    expect(effectiveQuotas().xlsxCells).toBe(10_000)
  })

  it("hands back a copy, so a caller cannot edit the defaults", () => {
    defaultsFor("demo").pdfPages = 9999
    expect(defaultsFor("demo").pdfPages).toBe(10)
  })
})

describe("environment overrides", () => {
  it("names variables the way the compose file spells them", () => {
    expect(envName("xlsxCells")).toBe("ANONIFY_QUOTA_XLSX_CELLS")
    expect(envName("pdfPages")).toBe("ANONIFY_QUOTA_PDF_PAGES")
    expect(envName("uploads")).toBe("ANONIFY_QUOTA_UPLOADS")
  })

  it("overrides one kind without restating the others", () => {
    process.env.ANONIFY_PROFILE = "demo"
    process.env.ANONIFY_QUOTA_XLSX_CELLS = "250000"

    const quotas = resolveQuotas("demo", envOverrides())
    expect(quotas.xlsxCells).toBe(250_000)
    expect(quotas.pdfPages).toBe(10)
  })

  it("accepts 0 as unlimited", () => {
    process.env.ANONIFY_PROFILE = "demo"
    process.env.ANONIFY_QUOTA_PDF_PAGES = "0"

    expect(isUnlimited(resolveQuotas("demo", envOverrides()).pdfPages)).toBe(true)
  })

  it("reports a malformed value rather than ignoring it", () => {
    // A quota someone believes they set and which is not in force is worse
    // than no setting at all.
    process.env.ANONIFY_QUOTA_IMAGES = "lots"
    expect(() => envOverrides()).toThrow(/ANONIFY_QUOTA_IMAGES/)
  })
})
