import { metricsSettings, mayScrape } from "@/lib/metrics/settings"
import {
  PEER_ADDRESS_HEADER,
  PEER_FORWARDED_HEADER,
} from "@/lib/runtime/http-servers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Prometheus metrics (#188): queue depth for autoscaling workers, step
 * durations and retries, CPU slots, provider calls and the database pool.
 *
 * Off unless `ANONIFY_METRICS=on`, and then either behind
 * `ANONIFY_METRICS_TOKEN` or open only to a direct peer on a private network.
 * No document data in any of it; see lib/metrics/registry.ts.
 */
export async function GET(request: Request) {
  const settings = metricsSettings()
  if (!settings.enabled) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    })
  }

  // Stamped from the socket before Next.js saw the request; absent (as on a
  // platform without our server) means unknown, which is treated as a proxy.
  const verdict = mayScrape(
    request.headers,
    {
      address: request.headers.get(PEER_ADDRESS_HEADER),
      forwarded: request.headers.get(PEER_FORWARDED_HEADER) !== "0",
    },
    settings
  )
  if (verdict === "unauthorized") {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": "Bearer", "cache-control": "no-store" },
    })
  }
  if (verdict === "forbidden") {
    return new Response("Forbidden", {
      status: 403,
      headers: { "cache-control": "no-store" },
    })
  }

  const { renderMetrics } = await import("@/lib/metrics/registry")
  const { body, contentType } = await renderMetrics()
  return new Response(body, {
    headers: { "content-type": contentType, "cache-control": "no-store" },
  })
}
