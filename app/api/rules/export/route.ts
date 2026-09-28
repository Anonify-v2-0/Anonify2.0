import { handleRouteError } from "@/lib/api/http"
import { exportOwnerRules } from "@/lib/redaction/owner-rules"
import { AccessError } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/**
 * The caller's global rules as a JSON file to keep or share.
 *
 * Patterns and options only: no counts, no document ids and no dates, because
 * the file travels to other people and other instances, and which documents a
 * rule matched is nobody else's business. See `exportOwnerRules`.
 */
export async function GET() {
  try {
    const identity = await peekIdentity()
    if (!identity) throw new AccessError("No session", 401)
    await consumeRateLimit("export", identity.networkKey)

    const file = await exportOwnerRules(identity.ownerKey)
    const date = new Date().toISOString().slice(0, 10)

    return new Response(JSON.stringify(file, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="anonify-rules-${date}.json"`,
        "cache-control": "no-store",
      },
    })
  } catch (error) {
    return handleRouteError(error, "rules.owner.export")
  }
}
