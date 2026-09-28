import { prisma } from "@/lib/database/prisma"
import { listOwnerRules } from "@/lib/redaction/owner-rules"
import { specOf } from "@/lib/redaction/patterns"
import type { RuleView } from "@/types/rules"

/**
 * Every rule that reaches the document on screen, at every scope.
 *
 * The counts are what the rules panel exists to show: a rule that quietly
 * redacts in files the reviewer has not opened has to say how much it did and
 * where, or switching it off is a guess.
 */
export async function rulesInScope(input: {
  documentId: string
  batchId: string | null
  ownerKey: string
}): Promise<RuleView[]> {
  const [documentRules, batchRules, ownerRules, copiesHere] = await Promise.all(
    [
      prisma.globalRule.findMany({
        where: {
          documentId: input.documentId,
          batchRuleId: null,
          ownerRuleId: null,
        },
        orderBy: { createdAt: "asc" },
      }),
      input.batchId
        ? prisma.batchRule.findMany({
            where: { batchId: input.batchId },
            orderBy: { createdAt: "asc" },
          })
        : Promise.resolve([]),
      listOwnerRules(input.ownerKey),
      prisma.globalRule.findMany({
        where: {
          documentId: input.documentId,
          OR: [{ batchRuleId: { not: null } }, { ownerRuleId: { not: null } }],
        },
        select: { id: true, batchRuleId: true, ownerRuleId: true },
      }),
    ]
  )

  const batchCopies = batchRules.length
    ? await prisma.globalRule.findMany({
        where: { batchRuleId: { in: batchRules.map((rule) => rule.id) } },
        select: { id: true, batchRuleId: true },
      })
    : []

  const counted = [
    ...documentRules.map((rule) => rule.id),
    ...batchCopies.map((copy) => copy.id),
    ...copiesHere.map((copy) => copy.id),
  ]
  const produced = counted.length
    ? await prisma.redaction.groupBy({
        by: ["ruleId"],
        where: { ruleId: { in: counted } },
        _count: { _all: true },
      })
    : []
  const redactionsOf = new Map(
    produced.map((row) => [row.ruleId, row._count._all])
  )
  const count = (ruleId: string | undefined) =>
    ruleId ? (redactionsOf.get(ruleId) ?? 0) : 0

  const views: RuleView[] = []

  for (const rule of documentRules) {
    const spec = specOf(rule)
    const here = count(rule.id)
    views.push({
      id: rule.id,
      scope: "document",
      ...spec,
      category: rule.category,
      enabled: rule.enabled,
      createdAt: rule.createdAt.toISOString(),
      copyId: rule.id,
      here,
      total: here,
      documents: 1,
    })
  }

  for (const rule of batchRules) {
    const copies = batchCopies.filter((copy) => copy.batchRuleId === rule.id)
    const copyHere = copiesHere.find((copy) => copy.batchRuleId === rule.id)
    views.push({
      id: rule.id,
      scope: "batch",
      ...specOf(rule),
      category: rule.category,
      enabled: rule.enabled,
      createdAt: rule.createdAt.toISOString(),
      copyId: copyHere?.id ?? null,
      here: count(copyHere?.id),
      total: copies.reduce((total, copy) => total + count(copy.id), 0),
      documents: copies.length,
    })
  }

  for (const rule of ownerRules) {
    const copyHere = copiesHere.find((copy) => copy.ownerRuleId === rule.id)
    views.push({
      id: rule.id,
      scope: "global",
      kind: rule.kind,
      pattern: rule.pattern,
      matchCase: rule.matchCase,
      wholeWord: rule.wholeWord,
      category: rule.category,
      enabled: rule.enabled,
      createdAt: rule.createdAt,
      expiresAt: rule.expiresAt,
      copyId: copyHere?.id ?? null,
      here: count(copyHere?.id),
      total: rule.redactions,
      documents: rule.documents,
    })
  }

  return views
}
