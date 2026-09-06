import { handleRouteError, jsonResponse } from "@/lib/api/http"
import { peekIdentity } from "@/lib/security/fingerprint"
import { batchLimits } from "@/lib/documents/batch-config"
import { activeProfile, RATE_LIMIT_NAMES } from "@/lib/security/rate-limit-config"
import { peekRateLimit } from "@/lib/security/rate-limit"
import { usageSnapshot } from "@/lib/security/usage"
import type { LimitsReport } from "@/types/limits"

export const runtime = "nodejs"

/**
 * What this caller has left.
 *
 * Read-only on purpose, and not itself rate limited: a panel that reports the
 * allowance must not spend it, and being told you are out of requests should
 * not be the thing that puts you out of requests.
 *
 * No session means nothing has been spent, so the answer is the configuration
 * with everything full — and no database work at all.
 */
export async function GET() {
  try {
    const identity = await peekIdentity()

    const rateLimits = await Promise.all(
      RATE_LIMIT_NAMES.map(async (name) => {
        const status = await peekRateLimit(
          name,
          identity?.networkKey ?? "anonymous"
        )
        return {
          name,
          limit: status.limit,
          windowSeconds: status.windowSeconds,
          remaining: status.remaining,
          resetAt: status.allowed ? null : status.resetAt.toISOString(),
        }
      })
    )

    const report: LimitsReport = {
      profile: activeProfile(),
      rateLimits,
      quotas: await usageSnapshot(identity?.quotaKey),
      // Read here rather than compiled into the bundle: a client component
      // cannot see a server environment variable, so the browser has to ask
      // what this deployment is actually configured for.
      batch: batchLimits(),
    }

    return jsonResponse(report)
  } catch (error) {
    return handleRouteError(error, "limits.read")
  }
}
