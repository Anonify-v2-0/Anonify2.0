import { handleRouteError, jsonResponse } from "@/lib/api/http"
import { admitStalled } from "@/lib/documents/admission"
import { cleanupExpired, markExpired } from "@/lib/workflows/cleanup"
import { recoverLostRuns } from "@/lib/workflows/recovery"
import {
  cancelProcessing,
  startProcessing,
} from "@/lib/workflows/start-processing"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Scheduled expiry sweep, and the queue's backstop.
 *
 * Vercel signs cron invocations with CRON_SECRET; without that header the
 * endpoint refuses, so nobody can trigger deletion from outside. The work
 * itself is idempotent, which is what makes retrying a partial run safe.
 *
 * The admission sweep rides along because it wants exactly the same schedule
 * and the same authority. Processing is admitted by events — an upload, a
 * retry, a run finishing — and an event that never arrives leaves a document
 * queued behind a slot nothing will free: a run killed mid-flight, a deploy in
 * the middle of a batch. This turns that into a delay rather than a document
 * nobody looks at again.
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

    const marked = await markExpired()
    // The whole backlog, within the budget (ANONIFY_CLEANUP_BUDGET_MS, inside
    // this route's maxDuration). Another sweep already running is reported as
    // skipped, with a 200: an overlapping cron is expected now and then (#170).
    const result = await cleanupExpired()
    // Runs a dead worker left behind go back to the queue (#182), before
    // admission, so they are started again in this same sweep.
    const recovered = await recoverLostRuns(cancelProcessing)
    // After the sweep, not before: a document that has just expired should not
    // be admitted a moment before it is deleted.
    const admitted = await admitStalled(startProcessing)

    return jsonResponse({ marked, ...result, recovered, admitted })
  } catch (error) {
    return handleRouteError(error, "cron.cleanup")
  }
}
