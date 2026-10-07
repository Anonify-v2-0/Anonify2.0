import { publicUrl } from "@/lib/config/public-url"
import { runsWorker } from "@/lib/config/role"
import { prisma } from "@/lib/database/prisma"
import {
  cachedReadiness,
  degraded,
  type ReadinessCheck,
} from "@/lib/health/ready"
import { healthState } from "@/lib/health/state"
import { redisRateStore } from "@/lib/services/rate-store-redis"
import {
  clientUploadMode,
  probeStorage,
  probeUploadCors,
} from "@/lib/storage/blob"
import { CorsRefusal } from "@/lib/storage/cors"

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
 *
 * So is a bucket's CORS, when browsers upload straight to it (#185): a bucket
 * that refuses them costs nothing but a detour, because the browser falls
 * back to uploading through the app. Without this, that detour is invisible.
 */

let corsUnreadableNoted = false

/** Rules change by hand, rarely; probes come every few seconds. */
const CORS_RECHECK_MS = 5 * 60 * 1000
let corsChecked: { at: number; failure: Error | null } | null = null

async function presignedCors(): Promise<void> {
  if (!corsChecked || Date.now() - corsChecked.at > CORS_RECHECK_MS) {
    // Only an answer is kept. A bucket that did not answer is the storage
    // check's news, and is asked again next time.
    let failure: Error | null = null
    try {
      await readPresignedCors()
    } catch (error) {
      if (!(error instanceof CorsRefusal)) throw error
      failure = error
    }
    corsChecked = { at: Date.now(), failure }
  }
  if (corsChecked.failure) throw corsChecked.failure
}

async function readPresignedCors(): Promise<void> {
  // Without a configured address there is no origin to check for; on Vercel
  // the deployment's own URL varies per preview.
  const origin = publicUrl()?.origin
  if (!origin) return
  let answer: Awaited<ReturnType<typeof probeUploadCors>>
  try {
    answer = await probeUploadCors(origin)
  } catch (error) {
    if (!(error instanceof CorsRefusal)) throw error
    throw new CorsRefusal(
      `${error.message} Browsers fall back to uploading through the app until a rule allows PUT from ${origin} with the headers the upload is signed with (docs/storage.md, "Direct uploads").`
    )
  }
  if (answer === "unreadable" && !corsUnreadableNoted) {
    corsUnreadableNoted = true
    console.info(
      JSON.stringify({
        level: "info",
        context: "health.ready",
        check: "presigned-cors",
        message:
          "Could not read the bucket's CORS rules (the service does not offer the API, or these credentials may not read them), so they are not checked. A browser that cannot upload straight to the bucket falls back to the app and is logged as upload.presigned-fallback.",
      })
    )
  }
}

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
  if (directUploads()) all["presigned-cors"] = degraded(presignedCors)
  if (process.env.WORKFLOW_TARGET_WORLD && runsWorker()) {
    all.world = async () => {
      if (!healthState().worldStarted)
        throw new Error("the workflow worker has not started")
    }
  }
  return all
}

/** A storage setting that does not parse is the storage check's to report. */
function directUploads(): boolean {
  try {
    return clientUploadMode() === "s3-presigned"
  } catch {
    return false
  }
}

export async function GET() {
  const readiness = await cachedReadiness(checks)
  return Response.json(readiness, {
    status: readiness.status === "ready" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  })
}
