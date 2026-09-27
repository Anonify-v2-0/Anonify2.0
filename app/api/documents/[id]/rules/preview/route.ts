import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  rateLimitResponse,
  readJson,
} from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { readNormalized } from "@/lib/documents/normalized-store"
import {
  patternErrorResponse,
  patternSpecSchema,
  requireRuleContext,
  RULE_SCOPES,
} from "@/lib/redaction/pattern-api"
import { compilePattern, PatternBudgetError } from "@/lib/redaction/patterns"
import { asTarget, RULE_TARGET_SELECT } from "@/lib/redaction/rules"
import {
  previewMatches,
  type BatchSearchDocument,
} from "@/lib/redaction/search"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

const previewSchema = z.object({
  spec: patternSpecSchema,
  scope: z.enum(RULE_SCOPES).default("document"),
})

/**
 * What a rule would do, before it does it.
 *
 * The rule dialog calls this as the reviewer types and shows the count and
 * the first matches in context; nothing is written. It runs the compiler and
 * the budget the rule itself will run under, so a preview that succeeds is a
 * rule that will — and one that runs out of budget says so here, rather than
 * after the reviewer has confirmed.
 *
 * For a batch rule the other documents are counted too, because that is the
 * part of the decision the reviewer cannot see from here. A global rule has
 * no other documents yet: it is previewed against this one, and the dialog
 * says it will also apply to future uploads.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/rules/preview">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const parsed = previewSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse("Invalid preview", 400)

    // Priced as the search it is: this document is scanned whole, and for a
    // batch rule every other document in the batch is too, which costs what
    // the batch search does.
    const limit = await consumeRateLimit(
      parsed.data.scope === "batch" ? "processing" : "search",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) return rateLimitResponse(limit, "rule previews")

    const ruleContext = await requireRuleContext(id, identity?.ownerKey)
    if (ruleContext instanceof Response) return ruleContext
    const { target, batchId } = ruleContext

    const compiled = compilePattern(parsed.data.spec)
    const here = await previewMatches(readNormalized(target), compiled)

    if (parsed.data.scope !== "batch" || !batchId) {
      return jsonResponse({ here })
    }

    const rows = await prisma.document.findMany({
      where: {
        batchId,
        expiresAt: { gt: new Date() },
        id: { not: target.id },
        kind: { not: "mbox" },
      },
      orderBy: { createdAt: "asc" },
      select: { ...RULE_TARGET_SELECT, originalName: true, status: true },
    })

    const documents: BatchSearchDocument[] = []
    for (const row of rows) {
      const other = asTarget(row)
      const base = { id: row.id, name: row.originalName, status: row.status }
      if (!other) {
        documents.push({
          ...base,
          count: null,
          note: "Still processing: it gets this rule when it finishes",
        })
        continue
      }
      try {
        const preview = await previewMatches(readNormalized(other), compiled, {
          samples: 0,
        })
        documents.push({ ...base, count: preview.count })
      } catch (error) {
        // Reported as the refusal it is: the rule would fail on this
        // document, so it would fail everywhere, and the reviewer should know
        // which file is the reason.
        if (error instanceof PatternBudgetError) {
          return errorResponse(`${error.message} (${row.originalName})`, 422, {
            code: `budget-${error.reason}`,
          })
        }
        throw error
      }
    }

    return jsonResponse({
      here,
      batch: {
        documents,
        total:
          here.count +
          documents.reduce(
            (total, document) => total + (document.count ?? 0),
            0
          ),
      },
    })
  } catch (error) {
    return (
      patternErrorResponse(error) ?? handleRouteError(error, "rules.preview")
    )
  }
}
