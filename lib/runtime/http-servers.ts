import diagnostics from "node:diagnostics_channel"
import type http from "node:http"

/**
 * The HTTP servers in this process and the requests they are answering
 * (#182).
 *
 * With `NEXT_MANUAL_SIG_HANDLE` set, Next leaves `SIGTERM` to the app, and
 * with it the job of closing its HTTP server, which it creates itself and
 * hands to nobody. Node publishes every request a server receives on the
 * `http.server.request.start` diagnostics channel, with the server it
 * arrived on. Subscribing is how the shutdown sequence finds the servers to
 * close and knows when their last request has been answered, without
 * reaching into Next.
 *
 * The workflow relay is one of these servers too, and its requests are steps.
 */

type ServerTracker = {
  servers: Set<http.Server>
  inFlight: number
  /** Held, so the channel and its subscriber are never collected. */
  channel?: diagnostics.Channel
}

const shared = globalThis as unknown as { anonifyHttp?: ServerTracker }

function tracker(): ServerTracker {
  shared.anonifyHttp ??= { servers: new Set(), inFlight: 0 }
  return shared.anonifyHttp
}

type RequestStart = {
  request: http.IncomingMessage
  server: http.Server
  response: http.ServerResponse
}

/**
 * The connecting peer's address, as the socket saw it, for a route that has
 * to know whether a request came from this network (/api/metrics, #188).
 * Route handlers are given no socket. Set on every request, overwriting
 * whatever a client sent under the same name, so it cannot be forged.
 */
export const PEER_ADDRESS_HEADER = "x-anonify-peer-address"

/**
 * "1" when the request arrived carrying a forwarding header, so it came
 * through a proxy; "0" when it did not. Read here, from the request as it
 * arrived, because Next.js fills in `X-Forwarded-For` itself, from the
 * socket, on every request that lacks one: by the time a route sees the
 * request, every request looks forwarded. Overwritten like the address.
 */
export const PEER_FORWARDED_HEADER = "x-anonify-peer-forwarded"

const FORWARDING_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"]

/** Starts watching. Requests that arrived before this are not counted. */
export function trackHttpServers(): void {
  const state = tracker()
  if (state.channel) return
  state.channel = diagnostics.channel("http.server.request.start")

  state.channel.subscribe((message) => {
    const { request, server, response } = message as RequestStart
    const forwarded = FORWARDING_HEADERS.some((name) => name in request.headers)
    request.headers[PEER_FORWARDED_HEADER] = forwarded ? "1" : "0"
    request.headers[PEER_ADDRESS_HEADER] = request.socket?.remoteAddress ?? ""
    state.servers.add(server)
    state.inFlight += 1
    response.once("close", () => {
      state.inFlight -= 1
    })
  })
}

/** Requests being answered right now, across every server. */
export function httpRequestsInFlight(): number {
  return tracker().inFlight
}

/**
 * Stops every server accepting connections, closes the idle ones, and
 * resolves once no request is left or `deadline` (epoch ms) passes. Returns
 * whether every request was answered.
 */
export async function closeHttpServers(
  deadline: number,
  pollMs = 100
): Promise<boolean> {
  const { servers } = tracker()
  for (const server of servers) {
    server.close()
    server.closeIdleConnections?.()
  }

  while (tracker().inFlight > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    // A keep-alive connection becomes idle once its request is answered.
    for (const server of servers) server.closeIdleConnections?.()
  }
  return tracker().inFlight === 0
}

/** For tests. */
export function resetHttpTracking(): void {
  shared.anonifyHttp = undefined
}
