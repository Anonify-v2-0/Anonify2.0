import { z } from "zod"

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { newRuleId } from "@/lib/documents/ids"
import { loadNormalized } from "@/lib/documents/normalized-store"
import { normalizeValue } from "@/lib/documents/shared/text"
import { findAllOccurrences } from "@/lib/redaction/entities"
import { detectionToRedaction, toDatabaseRow } from "@/lib/redaction/model"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

const createSchema = z.object({
  pattern: z.string().min(2).max(200),
  category: z.string().min(1).max(60),
})

/**
 * Global redaction rules.
 *
 * "Redact every occurrence of John Smith" is answered by searching the
 * normalized document here on the server — no second trip to a model, and no
 * chance of a different answer for the same string. Every occurrence it finds
 * is written as an accepted redaction, because accepting the rule is the user
 * saying so.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/rules">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("processing", identity?.networkKey ?? "anonymous")

    const document = await requireDocument(id, identity?.ownerKey)

    const parsed = createSchema.safeParse(await request.json())
    if (!parsed.success) {
      return errorResponse("Invalid rule", 400)
    }

    const record = await prisma.document.findUnique({
      where: { id: document.id },
      select: { normalizedBlobKey: true },
    })

    if (!record?.normalizedBlobKey || !document.encryptionKey) {
      return errorResponse("Document is not ready", 409)
    }

    const model = await loadNormalized(
      record.normalizedBlobKey,
      document.encryptionKey
    )

    const ruleId = newRuleId()
    const { pattern, category } = parsed.data

    await prisma.globalRule.create({
      data: {
        id: ruleId,
        documentId: document.id,
        pattern,
        normalizedPattern: normalizeValue(pattern),
        category,
        enabled: true,
      },
    })

    const occurrences = findAllOccurrences(model, pattern, {
      category,
      confidence: 1,
      reason: `Matches the global rule for "${pattern}"`,
    })

    const redactions = occurrences.map((occurrence) => ({
      ...detectionToRedaction(document.id, occurrence, "rule"),
      status: "accepted" as const,
      ruleId,
    }))

    if (redactions.length > 0) {
      await prisma.redaction.createMany({
        data: redactions.map((redaction) => toDatabaseRow(redaction)),
      })
    }

    return jsonResponse(
      {
        rule: { id: ruleId, pattern, category, enabled: true },
        redactions,
      },
      201
    )
  } catch (error) {
    return handleRouteError(error, "rules.create")
  }
}

/** Removes a rule and every redaction it created. */
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/documents/[id]/rules">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)

    const url = new URL(request.url)
    const ruleId = url.searchParams.get("ruleId")
    if (!ruleId) return errorResponse("No rule specified", 400)

    const removed = await prisma.redaction.deleteMany({
      where: { documentId: document.id, ruleId },
    })
    await prisma.globalRule.deleteMany({
      where: { documentId: document.id, id: ruleId },
    })

    return jsonResponse({ deleted: removed.count })
  } catch (error) {
    return handleRouteError(error, "rules.delete")
  }
}
