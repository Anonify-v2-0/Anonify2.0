import { buildId } from "@/lib/config/build"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Liveness: is this process alive (#167)?
 *
 * No database, no storage, no I/O of any kind. An orchestrator restarts a
 * replica that fails this, and a database outage must not restart every
 * replica in a loop: that is what /api/ready is for, which only stops traffic.
 *
 * It names the build, so a rollout can be watched replica by replica (#178).
 */
export function GET() {
  return Response.json(
    { status: "ok", build: buildId() },
    { headers: { "cache-control": "no-store" } }
  )
}
