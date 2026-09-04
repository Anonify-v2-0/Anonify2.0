import { handleRouteError, jsonResponse } from "@/lib/api/http"
import { cleanupExpired, markExpired } from "@/lib/workflows/cleanup"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Scheduled expiry sweep.
 *
 * Vercel signs cron invocations with CRON_SECRET; without that header the
 * endpoint refuses, so nobody can trigger deletion from outside. The work
 * itself is idempotent, which is what makes retrying a partial run safe.
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
    const result = await cleanupExpired()

    return jsonResponse({ marked, ...result })
  } catch (error) {
    return handleRouteError(error, "cron.cleanup")
  }
}
