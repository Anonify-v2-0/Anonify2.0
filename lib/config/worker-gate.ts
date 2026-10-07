import http from "node:http"

/**
 * A worker serves no people (#179).
 *
 * With `ANONIFY_ROLE=worker` the process still runs the Next server, because
 * the workflow runner delivers steps to it, but it should have no ingress.
 * In case it is given some by mistake, everything except the workflow routes
 * and the probes is answered 404 here, before Next.js sees the request. The
 * workflow routes keep their own guard in proxy.ts.
 *
 * Done at the HTTP server rather than in proxy.ts because only a worker needs
 * it: a proxy matching every path would run on every request in every role,
 * on Vercel included.
 */

const WORKER_PATHS = new Set(["/api/health", "/api/ready", "/api/metrics"])
const WORKFLOW_PREFIX = "/.well-known/workflow/"

const shared = globalThis as unknown as { anonifyWorkerGate?: boolean }

export function workerAllows(url: string | undefined): boolean {
  const path = new URL(url ?? "/", "http://worker").pathname
  return WORKER_PATHS.has(path) || path.startsWith(WORKFLOW_PREFIX)
}

/**
 * Wraps `http.Server.prototype.emit`, so it covers the server Next.js has
 * already created by the time instrumentation runs. Installed once.
 */
export function installWorkerGate(): void {
  if (shared.anonifyWorkerGate) return
  shared.anonifyWorkerGate = true

  const emit = http.Server.prototype.emit as (
    this: http.Server,
    event: string | symbol,
    ...args: unknown[]
  ) => boolean
  http.Server.prototype.emit = function (
    this: http.Server,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === "request") {
      const [request, response] = args as [
        http.IncomingMessage,
        http.ServerResponse,
      ]
      if (!workerAllows(request.url)) {
        response.writeHead(404, {
          "content-type": "text/plain",
          "cache-control": "no-store",
        })
        response.end("Not found")
        return true
      }
    }
    return emit.call(this, event, ...args)
  } as typeof http.Server.prototype.emit
}
