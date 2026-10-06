export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Liveness: is this process alive (#167)?
 *
 * No database, no storage, no I/O of any kind. An orchestrator restarts a
 * replica that fails this, and a database outage must not restart every
 * replica in a loop: that is what /api/ready is for, which only stops traffic.
 */
export function GET() {
  return Response.json(
    { status: "ok" },
    { headers: { "cache-control": "no-store" } }
  )
}
