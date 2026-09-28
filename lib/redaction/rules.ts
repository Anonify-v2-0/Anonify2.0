import { prisma } from "@/lib/database/prisma"
import { newBatchRuleId, newRuleId } from "@/lib/documents/ids"
import {
  readNormalized,
  type NormalizedReader,
} from "@/lib/documents/normalized-store"
import {
  occurrencesInPage,
  occurrencesInSheets,
  type OccurrenceOptions,
} from "@/lib/redaction/entities"
import { detectionToRedaction, toDatabaseRow } from "@/lib/redaction/model"
import {
  compilePattern,
  createBudget,
  storedNormalizedPattern,
  specOf,
  type CompiledPattern,
  type PatternBudget,
  type PatternSpec,
} from "@/lib/redaction/patterns"
import type { Detection, Redaction } from "@/types/redaction"

/**
 * Applying a decision to a document.
 *
 * "Redact every occurrence of John Smith" is answered by searching the
 * normalized document on the server — no second trip to a model, and no chance
 * of a different answer for the same string. Every occurrence becomes an
 * accepted redaction, because accepting the rule is the user saying so.
 *
 * This lives apart from the route because the same decision arrives by three
 * paths: a user applying a rule inside one document, a batch carrying a
 * decision into a document that had not finished processing when it was made,
 * and an owner's global rule reaching a document uploaded after it. They must
 * produce identical rows, so they run identical code.
 *
 * Every path is split in two: a *plan*, which reads the document and finds
 * every match within the budget, and a *write*, which records the rule and its
 * redactions in one transaction. Nothing is written until every document a
 * decision reaches has been planned, so a pattern that runs out of budget on
 * the fifth file of a batch leaves the first four untouched rather than
 * redacted under a rule that claims to be everywhere.
 */

export type AppliedRule = {
  ruleId: string
  redactions: Redaction[]
}

/** A document that has been normalized, which is the state a rule needs. */
export type RuleTarget = {
  id: string
  encryptionKey: string
  encryptionFormat: string | null
  normalizedBlobKey: string
  normalizedIndex: unknown
}

export const RULE_TARGET_SELECT = {
  id: true,
  encryptionKey: true,
  encryptionFormat: true,
  normalizedBlobKey: true,
  normalizedIndex: true,
} as const

/** Narrows a selected row to a target, or null when it cannot be searched yet. */
export function asTarget(row: {
  id: string
  encryptionKey: string | null
  encryptionFormat: string | null
  normalizedBlobKey: string | null
  normalizedIndex: unknown
}): RuleTarget | null {
  if (!row.encryptionKey || !row.normalizedBlobKey) return null
  return {
    id: row.id,
    encryptionKey: row.encryptionKey,
    encryptionFormat: row.encryptionFormat,
    normalizedBlobKey: row.normalizedBlobKey,
    normalizedIndex: row.normalizedIndex,
  }
}

/** One document's copy of a rule and the redactions it produces, not yet written. */
export type RulePlan = {
  rule: {
    id: string
    documentId: string
    pattern: string
    normalizedPattern: string
    kind: string
    matchCase: boolean
    wholeWord: boolean
    category: string
    enabled: boolean
    batchRuleId: string | null
    ownerRuleId: string | null
    createdAt?: Date
  }
  redactions: Redaction[]
}

/**
 * Every match of a rule in one document, a page at a time.
 *
 * Pages first, then sheets — the order `findAllOccurrences` has always used —
 * with one budget across all of them, because the budget is per document.
 */
export async function findRuleMatches(
  reader: NormalizedReader,
  compiled: CompiledPattern,
  options: OccurrenceOptions,
  budget: PatternBudget = createBudget()
): Promise<Detection[]> {
  const found: Detection[] = []
  const confidence = options.confidence ?? 0.9

  for await (const page of reader.pages()) {
    for (const range of compiled.find(page.text, budget)) {
      found.push({
        text: page.text.slice(range.start, range.end),
        category: options.category,
        confidence,
        reason: options.reason,
        page: page.number,
        start: range.start,
        end: range.end,
        global: true,
      })
    }
  }

  const { sheets } = await reader.outline()
  for (const sheet of sheets ?? []) {
    for (const cell of sheet.cells) {
      if (!cell.value) continue
      const [first] = compiled.find(cell.value, budget)
      if (!first) continue
      found.push({
        // A literal names the value it was asked for, as it always has; a
        // RegEx names what it actually matched, since the pattern is not a
        // value anybody could look for in the export.
        text:
          compiled.spec.kind === "literal"
            ? compiled.spec.pattern
            : cell.value.slice(first.start, first.end),
        category: options.category,
        confidence,
        reason: options.reason,
        worksheet: sheet.name,
        row: cell.row,
        column: cell.column,
        global: true,
      })
    }
  }

  return found
}

/**
 * `findAllOccurrences`, a page at a time.
 *
 * The same answer in the same order — pages first, then sheets — without the
 * model ever being whole: pages stream past and only what matched is kept.
 */
export async function findOccurrencesIn(
  reader: NormalizedReader,
  value: string,
  options: OccurrenceOptions
): Promise<Detection[]> {
  if (!value.trim()) return []
  const found: Detection[] = []
  for await (const page of reader.pages()) {
    found.push(...occurrencesInPage(page, value, options))
  }
  const { sheets } = await reader.outline()
  found.push(...occurrencesInSheets(sheets ?? [], value, options))
  return found
}

/** How a rule's pattern reads in a sentence. */
function quoted(spec: PatternSpec): string {
  return spec.kind === "regex" ? `/${spec.pattern}/` : `"${spec.pattern}"`
}

/** The sentence shown against every redaction a batch decision produced. */
export function batchRuleReason(pattern: string | PatternSpec): string {
  const spec = typeof pattern === "string" ? specOf({ pattern }) : pattern
  return `Carried across this batch: ${quoted(spec)} was decided in another document`
}

export function documentRuleReason(pattern: string | PatternSpec): string {
  const spec = typeof pattern === "string" ? specOf({ pattern }) : pattern
  // Not "global": that word belongs to the owner's rules, `ownerRuleReason`.
  return `Matches the rule ${quoted(spec)}`
}

export function ownerRuleReason(spec: PatternSpec): string {
  return `Matches your global rule ${quoted(spec)}`
}

/**
 * Plans one document's copy of a rule: reads the document, finds every match
 * within the budget, and returns the rows to write. Throws `PatternError` or
 * `PatternBudgetError` rather than returning a partial plan.
 */
export async function planRule(input: {
  target: RuleTarget
  spec: PatternSpec
  category: string
  reason: string
  ruleId?: string
  batchRuleId?: string | null
  ownerRuleId?: string | null
  createdAt?: Date
  budget?: PatternBudget
}): Promise<RulePlan> {
  const compiled = compilePattern(input.spec)
  const occurrences = await findRuleMatches(
    readNormalized(input.target),
    compiled,
    { category: input.category, confidence: 1, reason: input.reason },
    input.budget ?? createBudget()
  )

  const ruleId = input.ruleId ?? newRuleId()

  return {
    rule: {
      id: ruleId,
      documentId: input.target.id,
      pattern: compiled.spec.pattern,
      normalizedPattern: storedNormalizedPattern(compiled.spec),
      kind: compiled.spec.kind,
      matchCase: compiled.spec.matchCase,
      wholeWord: compiled.spec.wholeWord,
      category: input.category,
      enabled: true,
      batchRuleId: input.batchRuleId ?? null,
      ownerRuleId: input.ownerRuleId ?? null,
      createdAt: input.createdAt,
    },
    redactions: occurrences.map((occurrence) => ({
      ...detectionToRedaction(input.target.id, occurrence, "rule"),
      status: "accepted" as const,
      ruleId,
    })),
  }
}

/** The writes that record a set of plans; run them inside one transaction. */
export function planWrites(plans: RulePlan[]) {
  const redactions = plans.flatMap((plan) => plan.redactions)
  return [
    ...plans.map((plan) => prisma.globalRule.create({ data: plan.rule })),
    ...(redactions.length > 0
      ? [
          prisma.redaction.createMany({
            data: redactions.map((redaction) => toDatabaseRow(redaction)),
          }),
        ]
      : []),
  ]
}

export async function applyRuleToDocument(input: {
  target: RuleTarget
  spec: PatternSpec
  category: string
  reason: string
  /** Set when this is one document's copy of a batch-wide decision. */
  batchRuleId?: string
  /** Set when this is one document's copy of an owner's global rule. */
  ownerRuleId?: string
}): Promise<AppliedRule> {
  // Searched before the rule is recorded, as the model used to be loaded
  // before it: a model that cannot be read leaves no rule without redactions.
  const plan = await planRule(input)
  await prisma.$transaction(planWrites([plan]))
  return { ruleId: plan.rule.id, redactions: plan.redactions }
}

/**
 * Applies every batch decision this document has not seen yet.
 *
 * Called when a document finishes processing, because a batch is reviewed while
 * its documents are still arriving: a decision made on the first file has to
 * reach the fourth one, which was still being analyzed at the time. Rules
 * already materialized here are skipped, so running it twice — a retried
 * document, a resumed workflow step — does not double the redactions. A rule
 * that has been switched off is not carried.
 */
export async function carryBatchRules(
  documentId: string
): Promise<{ rulesApplied: number; redactions: number }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { ...RULE_TARGET_SELECT, batchId: true },
  })

  const target = document ? asTarget(document) : null
  if (!document?.batchId || !target) {
    return { rulesApplied: 0, redactions: 0 }
  }

  const [rules, existing] = await Promise.all([
    prisma.batchRule.findMany({
      where: { batchId: document.batchId, enabled: true },
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

    const spec = specOf(rule)
    const applied = await applyRuleToDocument({
      target,
      spec,
      category: rule.category,
      reason: batchRuleReason(spec),
      batchRuleId: rule.id,
    })

    rulesApplied += 1
    redactions += applied.redactions.length
  }

  return { rulesApplied, redactions }
}

/** Every document in a batch a decision can reach right now. */
async function batchTargets(batchId: string): Promise<RuleTarget[]> {
  const rows = await prisma.document.findMany({
    where: {
      batchId,
      expiresAt: { gt: new Date() },
      encryptionKey: { not: null },
      normalizedBlobKey: { not: null },
    },
    orderBy: { createdAt: "asc" },
    select: RULE_TARGET_SELECT,
  })
  return rows
    .map((row) => asTarget(row))
    .filter((target): target is RuleTarget => target !== null)
}

/** Plans a batch decision into every reachable document, before any write. */
async function planBatch(input: {
  batchId: string
  batchRuleId: string
  spec: PatternSpec
  category: string
  originDocumentId: string | null
}): Promise<RulePlan[]> {
  const targets = await batchTargets(input.batchId)
  const plans: RulePlan[] = []
  for (const target of targets) {
    plans.push(
      await planRule({
        target,
        spec: input.spec,
        category: input.category,
        // The document the reviewer was looking at says what it says; the
        // others say where the decision came from, because a redaction
        // appearing in a file nobody has opened yet needs to explain itself.
        reason:
          target.id === input.originDocumentId
            ? documentRuleReason(input.spec)
            : batchRuleReason(input.spec),
        batchRuleId: input.batchRuleId,
      })
    )
  }
  return plans
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
  spec: PatternSpec
  category: string
  originDocumentId: string
}): Promise<{
  batchRuleId: string
  applied: { documentId: string; redactions: Redaction[] }[]
}> {
  const batchRuleId = newBatchRuleId()
  const spec = compilePattern(input.spec).spec
  const plans = await planBatch({ ...input, spec, batchRuleId })

  await prisma.$transaction([
    prisma.batchRule.create({
      data: {
        id: batchRuleId,
        batchId: input.batchId,
        pattern: spec.pattern,
        normalizedPattern: storedNormalizedPattern(spec),
        kind: spec.kind,
        matchCase: spec.matchCase,
        wholeWord: spec.wholeWord,
        category: input.category,
        originDocumentId: input.originDocumentId,
      },
    }),
    ...planWrites(plans),
  ])

  return {
    batchRuleId,
    applied: plans.map((plan) => ({
      documentId: plan.rule.documentId,
      redactions: plan.redactions,
    })),
  }
}

/** Removes a batch decision and every redaction it produced, everywhere. */
export async function removeBatchRule(
  batchId: string,
  batchRuleId: string
): Promise<{ documents: number; redactions: number }> {
  const rule = await prisma.batchRule.findFirst({
    where: { id: batchRuleId, batchId },
    select: { id: true },
  })
  if (!rule) return { documents: 0, redactions: 0 }

  const copies = await prisma.globalRule.findMany({
    where: { batchRuleId },
    select: { id: true, documentId: true },
  })

  const [removed] = await prisma.$transaction([
    prisma.redaction.deleteMany({
      where: { ruleId: { in: copies.map((copy) => copy.id) } },
    }),
    prisma.globalRule.deleteMany({ where: { batchRuleId } }),
    prisma.batchRule.deleteMany({ where: { id: batchRuleId, batchId } }),
  ])

  return { documents: copies.length, redactions: removed.count }
}

/**
 * Changes a batch decision: switches it off or on, or rewrites its pattern.
 *
 * Switching off removes every redaction it made and keeps the rule listed, so
 * switching back on is one click. Switching on, or editing a rule that is on,
 * re-plans it into every reachable document and replaces what was there in
 * one transaction. A redaction the reviewer had rejected under the old rule
 * comes back accepted — the edit is a new decision, and the preview they
 * confirmed showed every match it would make.
 */
export async function updateBatchRule(input: {
  batchId: string
  batchRuleId: string
  enabled?: boolean
  spec?: PatternSpec
  category?: string
}): Promise<{ documents: number; redactions: number } | null> {
  const rule = await prisma.batchRule.findFirst({
    where: { id: input.batchRuleId, batchId: input.batchId },
  })
  if (!rule) return null

  const spec = input.spec ? compilePattern(input.spec).spec : specOf(rule)
  const category = input.category ?? rule.category
  const enabled = input.enabled ?? rule.enabled

  const copies = await prisma.globalRule.findMany({
    where: { batchRuleId: rule.id },
    select: { id: true },
  })
  const clear = [
    prisma.redaction.deleteMany({
      where: { ruleId: { in: copies.map((copy) => copy.id) } },
    }),
    prisma.globalRule.deleteMany({ where: { batchRuleId: rule.id } }),
  ]
  const record = prisma.batchRule.update({
    where: { id: rule.id },
    data: {
      pattern: spec.pattern,
      normalizedPattern: storedNormalizedPattern(spec),
      kind: spec.kind,
      matchCase: spec.matchCase,
      wholeWord: spec.wholeWord,
      category,
      enabled,
    },
  })

  if (!enabled) {
    await prisma.$transaction([...clear, record])
    return { documents: 0, redactions: 0 }
  }

  const plans = await planBatch({
    batchId: rule.batchId,
    batchRuleId: rule.id,
    spec,
    category,
    originDocumentId: rule.originDocumentId,
  })
  await prisma.$transaction([...clear, record, ...planWrites(plans)])

  return {
    documents: plans.length,
    redactions: plans.reduce((total, plan) => total + plan.redactions.length, 0),
  }
}

/**
 * Changes a rule that belongs to one document only.
 *
 * The same semantics as a batch decision, over one document: off removes its
 * redactions and keeps it listed; on, or an edit, replaces them with a fresh
 * plan.
 */
export async function updateDocumentRule(input: {
  target: RuleTarget
  ruleId: string
  enabled?: boolean
  spec?: PatternSpec
  category?: string
}): Promise<AppliedRule | null> {
  const rule = await prisma.globalRule.findFirst({
    where: {
      id: input.ruleId,
      documentId: input.target.id,
      batchRuleId: null,
      ownerRuleId: null,
    },
  })
  if (!rule) return null

  const spec = input.spec ? compilePattern(input.spec).spec : specOf(rule)
  const category = input.category ?? rule.category
  const enabled = input.enabled ?? rule.enabled

  // Prisma queries are lazy: nothing below runs until a transaction takes it.
  const unredact = prisma.redaction.deleteMany({
    where: { documentId: input.target.id, ruleId: rule.id },
  })

  if (!enabled) {
    await prisma.$transaction([
      unredact,
      prisma.globalRule.update({
        where: { id: rule.id },
        data: {
          pattern: spec.pattern,
          normalizedPattern: storedNormalizedPattern(spec),
          kind: spec.kind,
          matchCase: spec.matchCase,
          wholeWord: spec.wholeWord,
          category,
          enabled: false,
        },
      }),
    ])
    return { ruleId: rule.id, redactions: [] }
  }

  const plan = await planRule({
    target: input.target,
    spec,
    category,
    reason: documentRuleReason(spec),
    ruleId: rule.id,
    createdAt: rule.createdAt,
  })
  await prisma.$transaction([
    unredact,
    prisma.globalRule.delete({ where: { id: rule.id } }),
    ...planWrites([plan]),
  ])

  return { ruleId: rule.id, redactions: plan.redactions }
}
