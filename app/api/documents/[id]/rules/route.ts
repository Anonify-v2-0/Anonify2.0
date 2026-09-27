import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  readJson,
} from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import {
  createOwnerRule,
  removeOwnerRule,
  updateOwnerRule,
} from "@/lib/redaction/owner-rules"
import {
  categorySchema,
  patternErrorResponse,
  patternSpecSchema,
  requireRuleContext,
  RULE_SCOPES,
} from "@/lib/redaction/pattern-api"
import { rulesInScope } from "@/lib/redaction/rule-listing"
import {
  applyRuleToDocument,
  createBatchRule,
  documentRuleReason,
  removeBatchRule,
  updateBatchRule,
  updateDocumentRule,
} from "@/lib/redaction/rules"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"

/**
 * A rule is a pattern, a category, a scope and a kind.
 *
 * The older body — `{ pattern, category, scope }` with no `kind` — still
 * works and still means what it meant: a literal, case-insensitive rule.
 */
const createSchema = z
  .object({
    pattern: z.string().min(1).max(500),
    kind: z.enum(["literal", "regex"]).default("literal"),
    matchCase: z.boolean().default(false),
    wholeWord: z.boolean().default(false),
    category: categorySchema,
    /**
     * `batch` promotes the decision to every document uploaded alongside this
     * one, including the ones still processing; `global` to every document
     * this owner uploads from now on. `batch` is refused rather than silently
     * downgraded for a document that is not in a batch: "apply this
     * everywhere" quietly meaning "here only" is the failure this whole
     * feature exists to remove.
     */
    scope: z.enum(RULE_SCOPES).default("document"),
  })
  // A one-character literal is almost certainly a slip, as it always was;
  // a one-character RegEx such as `\d` is a pattern and is judged as one.
  .refine((value) => value.kind === "regex" || value.pattern.length >= 2, {
    message: "Too short",
  })

const updateSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(RULE_SCOPES),
  enabled: z.boolean().optional(),
  spec: patternSpecSchema.optional(),
  category: categorySchema.optional(),
})

/** Every rule that reaches this document, at every scope, with its counts. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/documents/[id]/rules">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")

    const document = await requireDocument(id, identity?.ownerKey)
    const record = await prisma.document.findUnique({
      where: { id: document.id },
      select: { batchId: true },
    })

    return jsonResponse({
      rules: await rulesInScope({
        documentId: document.id,
        batchId: record?.batchId ?? null,
        ownerKey: document.userFingerprint,
      }),
    })
  } catch (error) {
    return handleRouteError(error, "rules.list")
  }
}

/**
 * Creates a rule.
 *
 * "Redact every occurrence of John Smith" is answered by searching the
 * normalized document here on the server — no second trip to a model, and no
 * chance of a different answer for the same string. Every occurrence it finds
 * is written as an accepted redaction, because accepting the rule is the user
 * saying so. The dialog that sends this has already shown the reviewer the
 * matches (`/rules/preview`); nothing is written before they confirm.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/rules">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("processing", identity?.networkKey ?? "anonymous")

    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse("Invalid rule", 400)
    }

    const ruleContext = await requireRuleContext(id, identity?.ownerKey)
    if (ruleContext instanceof Response) return ruleContext
    const { document, target, batchId } = ruleContext

    const { category, scope, ...spec } = parsed.data
    const rule = { pattern: spec.pattern, kind: spec.kind, category, enabled: true }

    if (scope === "batch") {
      if (!batchId) {
        return errorResponse("This document is not part of a batch", 409)
      }

      const { batchRuleId, applied } = await createBatchRule({
        batchId,
        spec,
        category,
        originDocumentId: document.id,
      })

      const here = applied.find((entry) => entry.documentId === document.id)

      return jsonResponse(
        {
          rule: { id: batchRuleId, ...rule },
          scope,
          redactions: here?.redactions ?? [],
          batch: {
            id: batchId,
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

    if (scope === "global") {
      const { ownerRuleId, redactions } = await createOwnerRule({
        ownerKey: document.userFingerprint,
        spec,
        category,
        origin: target,
      })
      return jsonResponse(
        { rule: { id: ownerRuleId, ...rule }, scope, redactions },
        201
      )
    }

    const { ruleId, redactions } = await applyRuleToDocument({
      target,
      spec,
      category,
      reason: documentRuleReason(spec),
    })

    return jsonResponse({ rule: { id: ruleId, ...rule }, scope, redactions }, 201)
  } catch (error) {
    return patternErrorResponse(error) ?? handleRouteError(error, "rules.create")
  }
}

/**
 * Switches a rule off or on, or rewrites it, at whatever scope it lives.
 *
 * A batch or global rule is changed everywhere it reached, not only here —
 * the panel says so before the reviewer confirms. The client reloads this
 * document's redactions afterwards rather than trusting a diff.
 */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/documents/[id]/rules">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("processing", identity?.networkKey ?? "anonymous")

    const parsed = updateSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse("Invalid rule change", 400)

    const ruleContext = await requireRuleContext(id, identity?.ownerKey)
    if (ruleContext instanceof Response) return ruleContext
    const { document, target, batchId } = ruleContext
    const { id: ruleId, scope, ...changes } = parsed.data

    const result =
      scope === "document"
        ? await updateDocumentRule({ target, ruleId, ...changes })
        : scope === "batch"
          ? batchId
            ? await updateBatchRule({ batchId, batchRuleId: ruleId, ...changes })
            : null
          : await updateOwnerRule({
              ownerKey: document.userFingerprint,
              ownerRuleId: ruleId,
              ...changes,
            })

    if (!result) return errorResponse("Rule not found", 404)
    return jsonResponse({ updated: true })
  } catch (error) {
    return patternErrorResponse(error) ?? handleRouteError(error, "rules.update")
  }
}

/** Removes a rule and every redaction it created, everywhere it reached. */
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
    const scope = url.searchParams.get("scope") ?? "document"

    if (scope === "batch") {
      const record = await prisma.document.findUnique({
        where: { id: document.id },
        select: { batchId: true },
      })
      if (!record?.batchId) return errorResponse("Rule not found", 404)
      const removed = await removeBatchRule(record.batchId, ruleId)
      return jsonResponse({ deleted: removed.redactions, ...removed })
    }

    if (scope === "global") {
      const removed = await removeOwnerRule(document.userFingerprint, ruleId)
      if (!removed) return errorResponse("Rule not found", 404)
      return jsonResponse({ deleted: removed.redactions, ...removed })
    }

    const [removed] = await prisma.$transaction([
      prisma.redaction.deleteMany({
        where: { documentId: document.id, ruleId },
      }),
      prisma.globalRule.deleteMany({
        where: { documentId: document.id, id: ruleId },
      }),
    ])

    return jsonResponse({ deleted: removed.count })
  } catch (error) {
    return handleRouteError(error, "rules.delete")
  }
}
