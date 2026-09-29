/**
 * The name a download is saved under, written by the server and read back by
 * the browser.
 *
 * Both halves live here, with no imports, so the client components that read
 * the header use the same rules the routes wrote it with.
 */

/**
 * `attachment; filename="…"; filename*=UTF-8''…` for a name a user chose.
 *
 * Header values are ByteStrings: a name outside Latin-1 — an upload called
 * `收件箱.mbox` — makes `new Response` throw, which turned a download into a
 * 500 after the work of assembling it was already done. And a Latin-1 name
 * like `Müller` went out as raw 8-bit bytes that browsers decode differently.
 * So the plain `filename` is an ASCII stand-in for old clients, and the real
 * name travels percent-encoded as RFC 6266 `filename*`, which every current
 * browser prefers.
 */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_")
  // `toWellFormed` because `encodeURIComponent` throws on a lone surrogate,
  // and a name can carry one: the 80-character cap on upload names can cut an
  // emoji in half.
  const encoded = encodeURIComponent(filename.toWellFormed()).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * The name the server gave a download: `filename*` when there is one, since
 * the plain `filename` beside it is only the ASCII stand-in, then `filename`,
 * then the caller's own default.
 */
export function filenameFromDisposition(
  header: string | null,
  fallback: string
): string {
  const value = header ?? ""
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(value)
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended[1]).trim()
      if (decoded) return decoded
    } catch {
      // A malformed extended name: fall back to the plain one.
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^";\s]+))/i.exec(value)
  return (plain?.[1] ?? plain?.[2])?.trim() || fallback
}
