import { describe, expect, it } from "vitest"

import { publicUrl } from "@/lib/config/public-url"
import { siteMetadata } from "@/lib/config/site-metadata"

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

describe("the site's metadata (#168)", () => {
  it("resolves previews against the address it is run at, not built at", () => {
    const metadata = siteMetadata({
      ANONIFY_PUBLIC_URL: "https://redact.example.org",
    })
    expect(String(metadata.metadataBase)).toBe("https://redact.example.org/")
    // Everything else is the same for every instance.
    expect(metadata.openGraph?.images).toEqual([
      { url: "/Anonify.jpeg", width: 256, height: 256, alt: "Anonify" },
    ])
    expect(siteMetadata({ VERCEL: "1" }).metadataBase).toBeUndefined()
  })

  it("is read per request by the root layout, not exported statically", async () => {
    const { readFile } = await import("node:fs/promises")
    const layout = await readFile("app/layout.tsx", "utf8")
    expect(layout).toContain("export async function generateMetadata")
    expect(layout).toContain("await connection()")
    expect(layout).not.toMatch(/export const metadata\b/)
  })
})
