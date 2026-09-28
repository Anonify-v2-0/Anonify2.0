import { handleRouteError, jsonResponse } from "@/lib/api/http"
import { hushStatus } from "@/lib/assistant/hush"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/**
 * Whether Hush can answer on this instance, and if not, why.
 *
 * The panel asks before it offers a text box: "no provider configured" is a
 * different sentence from "today's spend cap is reached", and both are better
 * than a box that fails when used. Search, shortcuts and hand-written rules
 * never ask this, because none of them need a model.
 */
export async function GET() {
  try {
    const identity = await peekIdentity()
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")
    return jsonResponse(await hushStatus())
  } catch (error) {
    return handleRouteError(error, "assistant.status")
  }
}
