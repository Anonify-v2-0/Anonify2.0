import { prisma } from "@/lib/database/prisma"
import { newBatchRuleId, newRuleId } from "@/lib/documents/ids"
import { loadNormalized } from "@/lib/documents/normalized-store"
import { normalizeValue } from "@/lib/documents/shared/text"
import { findAllOccurrences } from "@/lib/redaction/entities"
import { detectionToRedaction, toDatabaseRow } from "@/lib/redaction/model"
import type { Redaction } from "@/types/redaction"

/**
 * Applying a decision to a document.
 *
 * "Redact every occurrence of John Smith" is answered by searching the
 * normalized document on the server — no second trip to a model, and no chance
 * of a different answer for the same string. Every occurrence becomes an
 * accepted redaction, because accepting the rule is the user saying so.
 *
 * This lives apart from the route because the same decision now arrives by two
 * paths: a user applying a rule inside one document, and a batch carrying a
 * decision into a document that had not finished processing when it was made.
 * They must produce identical rows, so they run identical code.
 */

export type AppliedRule = {
  ruleId: string
  redactions: Redaction[]
}

/** A document that has been normalized, which is the state a rule needs. */
type RuleTarget = {
  id: string
  encryptionKey: string
  normalizedBlobKey: string
}

export async function applyRuleToDocument(input: {
  target: RuleTarget
  pattern: string
  category: string
  reason: string
  /** Set when this is one document's copy of a batch-wide decision. */
  batchRuleId?: string
}): Promise<AppliedRule> {
  const { target, pattern, category } = input

  const model = await loadNormalized(
    target.normalizedBlobKey,
    target.encryptionKey
  )

  const ruleId = newRuleId()

  await prisma.globalRule.create({
    data: {
      id: ruleId,
      documentId: target.id,
      pattern,
      normalizedPattern: normalizeValue(pattern),
      category,
      enabled: true,
      batchRuleId: input.batchRuleId ?? null,
    },
  })

  const occurrences = findAllOccurrences(model, pattern, {
    category,
    confidence: 1,
    reason: input.reason,
  })

  const redactions = occurrences.map((occurrence) => ({
    ...detectionToRedaction(target.id, occurrence, "rule"),
    status: "accepted" as const,
    ruleId,
  }))

  if (redactions.length > 0) {
    await prisma.redaction.createMany({
      data: redactions.map((redaction) => toDatabaseRow(redaction)),
    })
  }

  return { ruleId, redactions }
}

/** The sentence shown against every redaction a batch decision produced. */
export function batchRuleReason(pattern: string): string {
  return `Carried across this batch: "${pattern}" was decided in another document`
}

export function documentRuleReason(pattern: string): string {
  return `Matches the global rule for "${pattern}"`
}

/**
 * Applies every batch decision this document has not seen yet.
 *
 * Called when a document finishes processing, because a batch is reviewed while
 * its documents are still arriving: a decision made on the first file has to
 * reach the fourth one, which was still being analyzed at the time. Rules
 * already materialized here are skipped, so running it twice — a retried
 * document, a resumed workflow step — does not double the redactions.
 */
export async function carryBatchRules(
  documentId: string
): Promise<{ rulesApplied: number; redactions: number }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      batchId: true,
      encryptionKey: true,
      normalizedBlobKey: true,
    },
  })

  if (!document?.batchId || !document.encryptionKey || !document.normalizedBlobKey) {
    return { rulesApplied: 0, redactions: 0 }
  }

  const [rules, existing] = await Promise.all([
    prisma.batchRule.findMany({
      where: { batchId: document.batchId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.globalRule.findMany({
      where: { documentId, batchRuleId: { not: null } },
      select: { batchRuleId: true },
    }),
  ])

  const already = new Set(existing.map((rule) => rule.batchRuleId))

  let rulesApplied = 0
  let redactions = 0

  for (const rule of rules) {
    if (already.has(rule.id)) continue

    const applied = await applyRuleToDocument({
      target: {
        id: document.id,
        encryptionKey: document.encryptionKey,
        normalizedBlobKey: document.normalizedBlobKey,
      },
      pattern: rule.pattern,
      category: rule.category,
      reason: batchRuleReason(rule.pattern),
      batchRuleId: rule.id,
    })

    rulesApplied += 1
    redactions += applied.redactions.length
  }

  return { rulesApplied, redactions }
}

/**
 * Making a decision once, for a whole batch.
 *
 * The decision is recorded on the batch and then materialized into every
 * document that is far enough along to be searched. Documents still processing
 * are not waited for — `carryBatchRules` picks them up when they finish, which
 * is what stops a slow file in the batch from holding up the review of the
 * others.
 */
export async function createBatchRule(input: {
  batchId: string
  pattern: string
  category: string
  originDocumentId: string
}): Promise<{
  batchRuleId: string
  applied: { documentId: string; redactions: Redaction[] }[]
}> {
  const batchRuleId = newBatchRuleId()

  await prisma.batchRule.create({
    data: {
      id: batchRuleId,
      batchId: input.batchId,
      pattern: input.pattern,
      normalizedPattern: normalizeValue(input.pattern),
      category: input.category,
      originDocumentId: input.originDocumentId,
    },
  })

  const targets = await prisma.document.findMany({
    where: {
      batchId: input.batchId,
      expiresAt: { gt: new Date() },
      encryptionKey: { not: null },
      normalizedBlobKey: { not: null },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, encryptionKey: true, normalizedBlobKey: true },
  })

  const applied: { documentId: string; redactions: Redaction[] }[] = []

  for (const target of targets) {
    if (!target.encryptionKey || !target.normalizedBlobKey) continue

    const result = await applyRuleToDocument({
      target: {
        id: target.id,
        encryptionKey: target.encryptionKey,
        normalizedBlobKey: target.normalizedBlobKey,
      },
      pattern: input.pattern,
      category: input.category,
      // The document the reviewer was looking at says what it says; the others
      // say where the decision came from, because a redaction appearing in a
      // file nobody has opened yet needs to explain itself.
      reason:
        target.id === input.originDocumentId
          ? documentRuleReason(input.pattern)
          : batchRuleReason(input.pattern),
      batchRuleId,
    })

    applied.push({ documentId: target.id, redactions: result.redactions })
  }

  return { batchRuleId, applied }
}

/** Removes a batch decision and every redaction it produced, everywhere. */
export async function removeBatchRule(
  batchId: string,
  batchRuleId: string
): Promise<{ documents: number; redactions: number }> {
  const copies = await prisma.globalRule.findMany({
    where: { batchRuleId },
    select: { id: true, documentId: true },
  })

  const removed = copies.length
    ? await prisma.redaction.deleteMany({
        where: { ruleId: { in: copies.map((copy) => copy.id) } },
      })
    : { count: 0 }

  await prisma.globalRule.deleteMany({ where: { batchRuleId } })
  await prisma.batchRule.deleteMany({ where: { id: batchRuleId, batchId } })

  return { documents: copies.length, redactions: removed.count }
}
