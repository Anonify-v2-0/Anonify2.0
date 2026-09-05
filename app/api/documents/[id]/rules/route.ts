import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
} from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import {
  applyRuleToDocument,
  createBatchRule,
  documentRuleReason,
} from "@/lib/redaction/rules"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

const createSchema = z.object({
  pattern: z.string().min(2).max(200),
  category: z.string().min(1).max(60),
  /**
   * `batch` promotes the decision to every document uploaded alongside this
   * one, including the ones still processing. It is refused rather than
   * silently downgraded for a document that is not in a batch: "apply this
   * everywhere" quietly meaning "here only" is the failure this whole feature
   * exists to remove.
   */
  scope: z.enum(["document", "batch"]).default("document"),
})

/**
 * Global redaction rules.
 *
 * "Redact every occurrence of John Smith" is answered by searching the
 * normalized document here on the server — no second trip to a model, and no
 * chance of a different answer for the same string. Every occurrence it finds
 * is written as an accepted redaction, because accepting the rule is the user
 * saying so.
 *
 * With `scope: "batch"` the same decision is recorded on the batch and applied
 * to every document in it — the answer to "this recurring name is a colleague,
 * not a subject", which nobody should have to give once per file.
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

    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse("Invalid rule", 400)
    }

    const record = await prisma.document.findUnique({
      where: { id: document.id },
      select: { normalizedBlobKey: true, batchId: true },
    })

    if (!record?.normalizedBlobKey || !document.encryptionKey) {
      return errorResponse("Document is not ready", 409)
    }

    const { pattern, category, scope } = parsed.data

    if (scope === "batch") {
      if (!record.batchId) {
        return errorResponse("This document is not part of a batch", 409)
      }

      const { batchRuleId, applied } = await createBatchRule({
        batchId: record.batchId,
        pattern,
        category,
        originDocumentId: document.id,
      })

      const here = applied.find((entry) => entry.documentId === document.id)

      return jsonResponse(
        {
          rule: { id: batchRuleId, pattern, category, enabled: true },
          scope,
          redactions: here?.redactions ?? [],
          batch: {
            id: record.batchId,
            documents: applied.length,
            redactions: applied.reduce(
              (total, entry) => total + entry.redactions.length,
              0
            ),
          },
        },
        201
      )
    }

    const { ruleId, redactions } = await applyRuleToDocument({
      target: {
        id: document.id,
        encryptionKey: document.encryptionKey,
        normalizedBlobKey: record.normalizedBlobKey,
      },
      pattern,
      category,
      reason: documentRuleReason(pattern),
    })

    return jsonResponse(
      {
        rule: { id: ruleId, pattern, category, enabled: true },
        scope,
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
