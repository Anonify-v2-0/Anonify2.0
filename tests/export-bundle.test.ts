import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import {
  collectBundle,
  filenameFrom,
  withVariant,
  zipBundle,
  type BundledArtifact,
} from "@/lib/redaction/export-bundle"

/**
 * "Download all" for a multi-copy export: every copy and its report in one
 * zip, named so the copies cannot overwrite each other, and never the vault.
 */

function served(body: string, filename: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-disposition": `attachment; filename="${filename}"` },
  })
}

const ARTIFACTS: BundledArtifact[] = [
  { variant: "masked", downloadUrl: "/d/masked", reportUrl: "/r/masked" },
  { variant: "tokenized", downloadUrl: "/d/tokenized", reportUrl: "/r/tokenized" },
]

/** What the download route serves: the same name for every copy. */
function server(overrides: Record<string, Response> = {}) {
  return async (url: string) =>
    overrides[url] ??
    (url.startsWith("/d/")
      ? served(`file ${url}`, "letter-redacted.pdf")
      : served(`{"report":"${url}"}`, "letter-redaction-report.json"))
}

describe("download all", () => {
  it("names every copy and report by its variant, so none overwrites another", async () => {
    const entries = await collectBundle(ARTIFACTS, server())

    expect(Object.keys(entries).sort()).toEqual([
      "letter-redacted-masked.pdf",
      "letter-redacted-tokenized.pdf",
      "letter-redaction-report-masked.json",
      "letter-redaction-report-tokenized.json",
    ])
  })

  it("zips exactly what the server served", async () => {
    const zipped = await zipBundle(await collectBundle(ARTIFACTS, server()))
    const files = unzipSync(zipped)

    expect(new TextDecoder().decode(files["letter-redacted-tokenized.pdf"])).toBe(
      "file /d/tokenized"
    )
    // Nothing but the copies and their reports: the vault reverses a copy and
    // is never fetched from the server, so it cannot end up in here.
    expect(Object.keys(files).some((name) => /vault/i.test(name))).toBe(false)
  })

  it("leaves out a report the artifact never had", async () => {
    const entries = await collectBundle(
      ARTIFACTS,
      server({ "/r/masked": served("", "", 404) })
    )
    expect(Object.keys(entries)).not.toContain("letter-redaction-report-masked.json")
    expect(Object.keys(entries)).toContain("letter-redacted-masked.pdf")
  })

  it("fails whole rather than handing over a zip with a copy missing", async () => {
    await expect(
      collectBundle(ARTIFACTS, server({ "/d/tokenized": served("", "", 401) }))
    ).rejects.toThrow("tokenized")
  })

  it("keeps two copies with the same variant name apart", async () => {
    const entries = await collectBundle(
      [ARTIFACTS[0], { ...ARTIFACTS[0], downloadUrl: "/d/again", reportUrl: "/r/again" }],
      server()
    )
    expect(Object.keys(entries)).toContain("letter-redacted-masked-2.pdf")
  })
})

describe("naming", () => {
  it("puts the variant before the extension", () => {
    expect(withVariant("letter-redacted.pdf", "tokenized")).toBe(
      "letter-redacted-tokenized.pdf"
    )
    expect(withVariant("README", "masked")).toBe("README-masked")
  })

  it("reads the name the server gave the file", () => {
    expect(filenameFrom(served("", "a b.pdf"), "x")).toBe("a b.pdf")
    expect(filenameFrom(new Response(""), "fallback.pdf")).toBe("fallback.pdf")
  })
})
