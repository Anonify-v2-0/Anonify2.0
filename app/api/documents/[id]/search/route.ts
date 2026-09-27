import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
} from "@/lib/api/http"
import { readNormalized } from "@/lib/documents/normalized-store"
import {
  patternErrorResponse,
  patternSpecSchema,
  requireRuleContext,
} from "@/lib/redaction/pattern-api"
import { compilePattern } from "@/lib/redaction/patterns"
import { searchPage, summarizeSearch } from "@/lib/redaction/search"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

const searchSchema = z.object({
  spec: patternSpecSchema,
  /** Set to ask for one page's hits; absent for where every hit is. */
  page: z.number().int().positive().max(9_999_999).optional(),
})

/**
 * Searches the document on the server, over the normalized model.
 *
 * Without `page`, the answer is where the hits are — a count per page and the
 * matching cells — which is what the counter and next/previous need. With
 * `page`, it is the hits on that page, which is what the viewer highlights.
 * Split this way so a 400-page document is read once per query, and a page
 * turn costs one page.
 *
 * POST rather than GET because the pattern is usually the very value being
 * looked for, and a query string is what access logs keep.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/search">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")

    const parsed = searchSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse("Invalid search", 400)

    const ruleContext = await requireRuleContext(id, identity?.ownerKey)
    if (ruleContext instanceof Response) return ruleContext

    const compiled = compilePattern(parsed.data.spec)
    const reader = readNormalized(ruleContext.target)

    if (parsed.data.page !== undefined) {
      return jsonResponse({
        page: parsed.data.page,
        hits: await searchPage(reader, compiled, parsed.data.page),
      })
    }

    return jsonResponse(await summarizeSearch(reader, compiled))
  } catch (error) {
    return (
      patternErrorResponse(error) ?? handleRouteError(error, "documents.search")
    )
  }
}
