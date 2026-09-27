import { handleRouteError, jsonResponse } from "@/lib/api/http"
import { listOwnerRules } from "@/lib/redaction/owner-rules"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/**
 * The caller's global rules, readable.
 *
 * The patterns are sealed at rest and opened here, for their owner only. A
 * caller with no session has no rules rather than an error: there is nothing
 * of theirs to protect, and the panel that asks shows an empty list.
 */
export async function GET() {
  try {
    const identity = await peekIdentity()
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")
    if (!identity) return jsonResponse({ rules: [] })
    return jsonResponse({ rules: await listOwnerRules(identity.ownerKey) })
  } catch (error) {
    return handleRouteError(error, "rules.owner.list")
  }
}
