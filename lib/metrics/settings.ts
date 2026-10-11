import { isIP } from "node:net"

/**
 * Whether metrics are served, and to whom (#188).
 *
 * `ANONIFY_METRICS=on` serves `/api/metrics` (off by default). With
 * `ANONIFY_METRICS_TOKEN` set, a scrape needs `Authorization: Bearer <token>`.
 * Without one, only a peer on this machine or a private network may scrape,
 * and only directly: a request that came through a proxy (it carries a
 * forwarding header) is refused, because behind an ingress every visitor's
 * address is the proxy's private one.
 */

type Env = Record<string, string | undefined>

export type MetricsSettings = { enabled: boolean; token?: string }

export function metricsSettings(env: Env = process.env): MetricsSettings {
  const raw = env.ANONIFY_METRICS?.trim().toLowerCase()
  if (raw && raw !== "on" && raw !== "off")
    throw new Error(
      `ANONIFY_METRICS must be on or off, got "${env.ANONIFY_METRICS}"`
    )
  const token = env.ANONIFY_METRICS_TOKEN?.trim()
  if (token !== undefined && token !== "" && token.length < 16)
    throw new Error("ANONIFY_METRICS_TOKEN must be at least 16 characters")
  return { enabled: raw === "on", ...(token ? { token } : {}) }
}

/** Loopback, RFC 1918, carrier-grade NAT, link-local and IPv6 unique-local. */
export function isPrivateAddress(address: string | null | undefined): boolean {
  if (!address) return false
  let ip = address.trim()
  // An IPv4 peer on a dual-stack socket.
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7)

  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number)
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    )
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase()
    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:")
    )
  }
  return false
}

export type ScrapeVerdict = "allow" | "unauthorized" | "forbidden"

/** Where a request came from, as the socket saw it (lib/runtime/http-servers.ts). */
export type Peer = {
  address: string | null
  /** Whether it arrived carrying a forwarding header. Unknown counts as yes. */
  forwarded: boolean
}

/** Whether this request may read the metrics. */
export function mayScrape(
  headers: Headers,
  peer: Peer,
  settings: MetricsSettings
): ScrapeVerdict {
  if (settings.token) {
    return headers.get("authorization") === `Bearer ${settings.token}`
      ? "allow"
      : "unauthorized"
  }
  if (peer.forwarded) return "forbidden"
  return isPrivateAddress(peer.address) ? "allow" : "forbidden"
}
