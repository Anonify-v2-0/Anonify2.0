import { describe, expect, it } from "vitest"

import { publicUrl } from "@/lib/config/public-url"

describe("the public URL link previews resolve against", () => {
  it("is ANONIFY_PUBLIC_URL when set, path included", () => {
    expect(
      publicUrl({ ANONIFY_PUBLIC_URL: " https://redact.example.org/anonify " })
        ?.href
    ).toBe("https://redact.example.org/anonify")
  })

  it("is left to Next.js on Vercel, which knows the deployment's address", () => {
    expect(publicUrl({ VERCEL: "1" })).toBeUndefined()
    // An operator's explicit address still wins there.
    expect(
      publicUrl({ VERCEL: "1", ANONIFY_PUBLIC_URL: "https://a.example" })?.href
    ).toBe("https://a.example/")
  })

  it("is the local address Next.js would assume, stated, when nothing says otherwise", () => {
    expect(publicUrl({})?.href).toBe("http://localhost:3000/")
    expect(publicUrl({ PORT: "8080" })?.href).toBe("http://localhost:8080/")
  })

  it("refuses a value that would look configured and not be", () => {
    for (const value of [
      "redact.example.org",
      "ftp://redact.example.org",
      "https://user:secret@redact.example.org",
      "https://redact.example.org/?token=secret",
    ]) {
      expect(() => publicUrl({ ANONIFY_PUBLIC_URL: value })).toThrow(
        /^ANONIFY_PUBLIC_URL must be/
      )
    }
  })
})
