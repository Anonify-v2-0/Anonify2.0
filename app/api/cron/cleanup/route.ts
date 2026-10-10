import { handleRouteError, jsonResponse } from "@/lib/api/http"
import {
  cancelProcessing,
  startProcessing,
} from "@/lib/workflows/start-processing"
import { sweep } from "@/lib/workflows/sweep"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * The sweep, for an external scheduler: Vercel's cron, a platform scheduler,
 * or Compose's deprecated `scheduler` service.
 *
 * Vercel signs cron invocations with CRON_SECRET; without that header the
 * endpoint refuses, so nobody can trigger deletion from outside. The work
 * itself is idempotent, which is what makes retrying a partial run safe.
 *
 * Self-hosted workers run the same sweep on their own timer (#183), under the
 * same lock, so calling this as well is harmless. See lib/workflows/sweep.ts
 * for what a sweep does.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== "production"
  return request.headers.get("authorization") === `Bearer ${secret}`
}

export async function GET(request: Request) {
  try {
    if (!authorized(request)) {
      return jsonResponse({ error: "Unauthorized" }, 401)
    }

    // The whole backlog, within the budget (ANONIFY_CLEANUP_BUDGET_MS, inside
    // this route's maxDuration). Another sweep already running is reported as
    // skipped, with a 200: an overlapping trigger is expected now and then.
    const result = await sweep({
      startRun: startProcessing,
      cancelRun: cancelProcessing,
    })
    return jsonResponse(result)
  } catch (error) {
    return handleRouteError(error, "cron.cleanup")
  }
}
