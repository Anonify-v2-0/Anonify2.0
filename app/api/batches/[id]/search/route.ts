import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
} from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { requireBatch } from "@/lib/documents/batches"
import { readNormalized } from "@/lib/documents/normalized-store"
import {
  patternErrorResponse,
  patternSpecSchema,
} from "@/lib/redaction/pattern-api"
import { compilePattern, PatternBudgetError } from "@/lib/redaction/patterns"
import { asTarget, RULE_TARGET_SELECT } from "@/lib/redaction/rules"
import {
  summarizeSearch,
  type BatchSearchDocument,
} from "@/lib/redaction/search"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

const searchSchema = z.object({ spec: patternSpecSchema })

/**
 * Searches every document in a batch, answering with a count per document.
 *
 * Counts rather than hits: the reviewer is deciding which file to open next,
 * and the hits are fetched by that file's own search once it is open. A
 * document still processing is listed with no count and says so — "0" would
 * claim it had been searched.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/batches/[id]/search">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const batch = await requireBatch(id, identity?.ownerKey)
    await consumeRateLimit("processing", identity?.networkKey ?? "anonymous")

    const parsed = searchSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse("Invalid search", 400)

    const compiled = compilePattern(parsed.data.spec)

    const rows = await prisma.document.findMany({
      where: { batchId: batch.id, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
      select: {
        ...RULE_TARGET_SELECT,
        originalName: true,
        status: true,
        kind: true,
      },
    })

    const documents: BatchSearchDocument[] = []
    for (const row of rows) {
      // A mailbox is the batch, not a document in it: it has no text.
      if (row.kind === "mbox") continue
      const target = asTarget(row)
      const base = { id: row.id, name: row.originalName, status: row.status }
      if (!target) {
        documents.push({ ...base, count: null, note: "Still processing" })
        continue
      }
      try {
        const summary = await summarizeSearch(readNormalized(target), compiled)
        documents.push({ ...base, count: summary.total })
      } catch (error) {
        if (!(error instanceof PatternBudgetError)) throw error
        documents.push({
          ...base,
          count: null,
          note: "Too many matches to count",
        })
      }
    }

    return jsonResponse({ documents })
  } catch (error) {
    return (
      patternErrorResponse(error) ?? handleRouteError(error, "batches.search")
    )
  }
}
