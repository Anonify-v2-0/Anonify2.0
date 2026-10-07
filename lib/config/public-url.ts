/**
 * The address people reach this instance at, for the one thing that needs it:
 * absolute URLs in link previews (`og:image`, `twitter:image`).
 *
 * A crawler cannot follow a relative image URL, so Next.js resolves them
 * against `metadataBase`. On Vercel it derives one from the deployment's own
 * system variables, preview deployments included. Anywhere else it has nothing
 * to go on and falls back to `http://localhost:3000`, which is what a
 * self-hosted instance's link previews pointed at until this existed.
 *
 * No imports, so the root layout can read it without pulling in anything else.
 */

/**
 * `ANONIFY_PUBLIC_URL` when set; nothing on Vercel, which Next.js resolves
 * better on its own; otherwise the local address Next.js would assume anyway,
 * stated rather than guessed.
 *
 * Read per request, by the root layout's `generateMetadata`, so an image
 * built once serves any address (#168), and once at start-up by
 * instrumentation.ts. A malformed value throws there, stopping the server: a
 * setting that looks configured and is not in force is the failure this
 * codebase refuses everywhere else.
 */
export function publicUrl(
  env: Record<string, string | undefined> = process.env
): URL | undefined {
  const configured = env.ANONIFY_PUBLIC_URL?.trim()
  if (configured) {
    let url: URL
    try {
      url = new URL(configured)
    } catch {
      throw new Error(
        "ANONIFY_PUBLIC_URL must be an absolute http(s) URL, such as https://redact.example.org"
      )
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "ANONIFY_PUBLIC_URL must be an http(s) URL without credentials, a query or a fragment"
      )
    return url
  }
  if (env.VERCEL) return undefined
  return new URL(`http://localhost:${env.PORT?.trim() || 3000}`)
}
