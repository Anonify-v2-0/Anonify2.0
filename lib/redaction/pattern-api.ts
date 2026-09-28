import { z } from "zod"

import { errorResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { OwnerRuleLimitError } from "@/lib/redaction/owner-rules"
import {
  PATTERN_KINDS,
  PATTERN_MAX_LENGTH,
  PatternBudgetError,
  PatternError,
  type PatternSpec,
} from "@/lib/redaction/patterns"
import { asTarget, type RuleTarget } from "@/lib/redaction/rules"
import {
  requireDocument,
  type OwnedDocument,
} from "@/lib/security/access-control"

/**
 * What the search, rule and assistant routes share: the shape a pattern
 * arrives in, how its refusals become responses, and how a route gets from a
 * document id to something a pattern can run against.
 *
 * Patterns travel in request bodies, never in query strings. A search term is
 * very often the exact value being redacted, and a URL is the part of a
 * request that proxies, access logs and browser history all keep.
 */

export const patternSpecSchema = z.object({
  kind: z.enum(PATTERN_KINDS).default("literal"),
  pattern: z.string().min(1).max(PATTERN_MAX_LENGTH),
  matchCase: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
}) satisfies z.ZodType<PatternSpec, unknown>

export const RULE_SCOPES = ["document", "batch", "global"] as const
export type RuleScopeName = (typeof RULE_SCOPES)[number]

export const categorySchema = z.string().min(1).max(60)

/**
 * The refusals a reviewer can act on, as responses that say so.
 *
 * A pattern the compiler refused is the reviewer's to fix (400); one that ran
 * out of budget is too (422) — the document is not broken, the pattern is too
 * broad. Anything else is left to `handleRouteError`, which never repeats an
 * internal message.
 */
export function patternErrorResponse(error: unknown): Response | null {
  if (error instanceof PatternError) {
    return errorResponse(error.message, 400, { code: error.code })
  }
  if (error instanceof PatternBudgetError) {
    return errorResponse(error.message, 422, { code: `budget-${error.reason}` })
  }
  if (error instanceof OwnerRuleLimitError) {
    return errorResponse(error.message, 409, { code: "rule-limit" })
  }
  return null
}

export type RuleContext = {
  document: OwnedDocument
  target: RuleTarget
  batchId: string | null
}

/** The caller's document, ready to be searched, or a 409 while it is not. */
export async function requireRuleContext(
  documentId: string,
  ownerKey: string | undefined
): Promise<RuleContext | Response> {
  const document = await requireDocument(documentId, ownerKey)
  const record = await prisma.document.findUnique({
    where: { id: document.id },
    select: {
      id: true,
      encryptionKey: true,
      encryptionFormat: true,
      normalizedBlobKey: true,
      normalizedIndex: true,
      batchId: true,
    },
  })
  const target = record ? asTarget(record) : null
  if (!record || !target) {
    return errorResponse("Document is not ready", 409)
  }
  return { document, target, batchId: record.batchId }
}
