import { handleRouteError, jsonResponse } from "@/lib/api/http"
import { aggregateUsage } from "@/lib/ai/usage-report"
import { EMPTY_TOTALS } from "@/lib/ai/usage-types"
import { peekIdentity } from "@/lib/security/fingerprint"

export const runtime = "nodejs"

/**
 * Analysis usage across the caller's own documents. No session means no
 * documents and so no spend — answered without touching the database.
 */
export async function GET() {
  try {
    const identity = await peekIdentity()
    if (!identity) {
      return jsonResponse({
        documents: 0,
        totals: EMPTY_TOTALS,
        byModel: [],
        estimatedCostUsd: null,
      })
    }

    return jsonResponse(await aggregateUsage(identity.ownerKey))
  } catch (error) {
    return handleRouteError(error, "usage.aggregate")
  }
}
