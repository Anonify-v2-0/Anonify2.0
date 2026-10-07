import { runsWorker } from "@/lib/config/role"
import { prisma } from "@/lib/database/prisma"
import {
  cachedReadiness,
  degraded,
  type ReadinessCheck,
} from "@/lib/health/ready"
import { healthState } from "@/lib/health/state"
import { redisRateStore } from "@/lib/services/rate-store-redis"
import { probeStorage } from "@/lib/storage/blob"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Readiness: can this replica take traffic and jobs right now (#167)?
 *
 * 200 with how long each dependency took, or 503 naming what failed: the
 * database, the storage backend, the workflow worker, or that the replica is
 * draining. Unauthenticated, because a probe has no session, and it returns
 * no document data and no detail about a failure; the detail is logged.
 *
 * Redis, when ANONIFY_RATE_STORE=redis (#184), is checked but cannot fail
 * readiness: without it the AI and OCR pacing falls back to each process and
 * the inbound limiter to Postgres, so a replica still works. It is reported
 * under `degraded`.
 */
function checks(): Record<string, ReadinessCheck> {
  const all: Record<string, ReadinessCheck> = {
    database: async () => {
      await prisma.$queryRaw`SELECT 1`
    },
    storage: probeStorage,
  }
  // A replica that runs the workflow worker is not ready until it has
  // started. One that does not, on Vercel or with ANONIFY_ROLE=web (#179),
  // has nothing to wait for.
  if (process.env.ANONIFY_RATE_STORE?.trim().toLowerCase() === "redis") {
    all.redis = degraded(() => redisRateStore().probe())
  }
  if (process.env.WORKFLOW_TARGET_WORLD && runsWorker()) {
    all.world = async () => {
      if (!healthState().worldStarted)
        throw new Error("the workflow worker has not started")
    }
  }
  return all
}

export async function GET() {
  const readiness = await cachedReadiness(checks)
  return Response.json(readiness, {
    status: readiness.status === "ready" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  })
}
