import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
} from "@/lib/api/http"
import { importOwnerRules, ruleFileSchema } from "@/lib/redaction/owner-rules"
import { patternErrorResponse } from "@/lib/redaction/pattern-api"
import { getIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/**
 * Adds the rules in an exported rule file to the caller's global rules.
 *
 * Every pattern is compiled by the same compiler the rules will run under,
 * and one this instance refuses is reported by its position in the file
 * rather than stored — a rule file is input from elsewhere. Duplicates are
 * skipped. Imported rules reach future uploads only; nothing already open
 * changes.
 */
export async function POST(request: Request) {
  try {
    const identity = await getIdentity()
    await consumeRateLimit("processing", identity.networkKey)

    const parsed = ruleFileSchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse(
        "That is not an Anonify rule file. Export one from the rules panel to see the format.",
        400
      )
    }

    return jsonResponse(await importOwnerRules(identity.ownerKey, parsed.data))
  } catch (error) {
    return (
      patternErrorResponse(error) ??
      handleRouteError(error, "rules.owner.import")
    )
  }
}
