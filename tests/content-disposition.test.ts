import { describe, expect, it } from "vitest"

import {
  contentDisposition,
  filenameFromDisposition,
} from "@/lib/api/content-disposition"
import { artifactName, baseName } from "@/lib/redaction/archive"

/**
 * A download named after an upload. The name is the user's, so it can be in
 * any script, and a header value is a ByteString: what the server writes has
 * to survive `new Response`, and what the browser reads back has to be the
 * name, not its ASCII stand-in.
 */

/** The header as it leaves the server — this is where a bad value throws. */
function served(filename: string): string | null {
  return new Response(null, {
    headers: { "content-disposition": contentDisposition(filename) },
  }).headers.get("content-disposition")
}

describe("writing the name", () => {
  it.each([
    ["a name outside Latin-1", "收件箱.mbox"],
    ["Cyrillic", "Отчёт-redacted.pdf"],
    ["an emoji", "📬 inbox-redacted.zip"],
    ["Latin-1 with RFC 5987's reserved characters", "Müller's (1)*.pdf"],
    ["quotes and backslashes", 'a "quoted" \\ name.pdf'],
    ["a line break", "evil\r\nSet-Cookie: x=1.pdf"],
  ])("sends %s and reads it back exactly", (_, name) => {
    const header = served(name)

    expect(filenameFromDisposition(header, "fallback")).toBe(name)
  })

  it("keeps the plain filename to printable ASCII, for clients that read only that", () => {
    const header = contentDisposition('收件箱 "Müller"\r\n.mbox')

    expect(header).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=/)
    expect(header).toContain('filename="___ _M_ller___.mbox"')
    expect(header).not.toMatch(/[\r\n]/)
  })

  it("percent-encodes what RFC 5987 reserves, which encodeURIComponent leaves", () => {
    expect(contentDisposition("Müller's (1)*.pdf")).toContain(
      "filename*=UTF-8''M%C3%BCller%27s%20%281%29%2A.pdf"
    )
  })

  it("survives a name whose emoji the length cap cut in half", () => {
    const name = artifactName(`a${"📬".repeat(50)}.mbox`, "mbox")
    expect(name.isWellFormed()).toBe(false)

    const header = served(name)

    expect(filenameFromDisposition(header, "fallback")).toBe(
      name.toWellFormed()
    )
  })

  it("names a mailbox, and the zip of one upload, the way the batch download does", () => {
    for (const upload of ["收件箱.mbox", "Отчёт.pdf", "Müller.eml"]) {
      const file = artifactName(upload, upload.split(".").pop() ?? "")
      const zip = `${baseName(upload)}-redacted.zip`

      expect(filenameFromDisposition(served(file), "x")).toBe(file)
      expect(filenameFromDisposition(served(zip), "x")).toBe(zip)
    }
  })
})

describe("reading the name", () => {
  it("prefers filename* over the ASCII stand-in beside it", () => {
    expect(
      filenameFromDisposition(contentDisposition("收件箱-redacted.mbox"), "x")
    ).toBe("收件箱-redacted.mbox")
  })

  it("falls back to the plain name when filename* is malformed", () => {
    expect(
      filenameFromDisposition(
        `attachment; filename="plain.mbox"; filename*=UTF-8''%E6%94%B6%`,
        "x"
      )
    ).toBe("plain.mbox")
  })

  it("reads a plain name, quoted or not", () => {
    expect(filenameFromDisposition('attachment; filename="a b.pdf"', "x")).toBe(
      "a b.pdf"
    )
    expect(filenameFromDisposition("attachment; filename=a.pdf", "x")).toBe(
      "a.pdf"
    )
  })

  it("uses the caller's default when there is no name", () => {
    expect(filenameFromDisposition(null, "fallback.zip")).toBe("fallback.zip")
    expect(filenameFromDisposition("attachment", "fallback.zip")).toBe(
      "fallback.zip"
    )
    expect(
      filenameFromDisposition('attachment; filename=""', "fallback.zip")
    ).toBe("fallback.zip")
  })
})
