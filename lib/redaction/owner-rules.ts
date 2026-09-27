import { z } from "zod"

import { prisma } from "@/lib/database/prisma"
import { randomId } from "@/lib/documents/ids"
import {
  asTarget,
  planRule,
  planWrites,
  ownerRuleReason,
  RULE_TARGET_SELECT,
  type RuleTarget,
} from "@/lib/redaction/rules"
import {
  compilePattern,
  PATTERN_KINDS,
  PATTERN_MAX_LENGTH,
  type PatternSpec,
} from "@/lib/redaction/patterns"
import { openWithMasterKey, sealWithMasterKey } from "@/lib/storage/encryption"
import type { Redaction } from "@/types/redaction"

/**
 * Global rules: decisions an owner takes once for every document they upload.
 *
 * "Our internal project codenames are always confidential" is not a decision
 * about a document or a batch. It is about the reviewer's work, so it belongs
 * to the reviewer — which in this application means the anonymous session
 * that owns their documents — and it is applied at the end of processing to
 * everything they upload afterwards, exactly the way a batch decision is
 * carried into a document that finished late.
 *
 * Every other rule lives and dies with a document, so its pattern shares the
 * document's lifetime. This one does not, which makes the pattern document
 * content kept for longer than any document is. So:
 *
 *   - the pattern is sealed under the master key and never stored in the clear;
 *   - a rule expires once it has gone unused for as long as the session cookie
 *     that owns it lives, because after that nobody can reach it; and
 *   - export and import are how somebody keeps a rule set beyond that, in a
 *     file they hold, which is also how a team shares one across instances.
 *
 * A document's copy of a global rule is an ordinary `GlobalRule` row carrying
 * `ownerRuleId`, and it is deleted with its document like every other copy.
 */

/** How long an unused rule survives: the life of the session cookie. */
export const OWNER_RULE_IDLE_DAYS = 30
const IDLE_MS = OWNER_RULE_IDLE_DAYS * 24 * 60 * 60 * 1000

/** More than anybody maintains by hand, few enough to plan on every upload. */
export const OWNER_RULE_LIMIT = 200

export const newOwnerRuleId = () => randomId("orl", 16)

export function idleExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + IDLE_MS)
}

export function sealPattern(pattern: string): string {
  return sealWithMasterKey(Buffer.from(pattern, "utf8")).toString("base64")
}

export function openPattern(sealed: string): string {
  return openWithMasterKey(Buffer.from(sealed, "base64")).toString("utf8")
}

export type OwnerRuleView = {
  id: string
  kind: PatternSpec["kind"]
  pattern: string
  matchCase: boolean
  wholeWord: boolean
  category: string
  enabled: boolean
  createdAt: string
  expiresAt: string
  originDocumentId: string | null
  /** Documents that currently hold a copy. */
  documents: number
  /** Redactions those copies produced. */
  redactions: number
}

type OwnerRuleRow = Awaited<
  ReturnType<typeof prisma.ownerRule.findMany>
>[number]

function specFromRow(row: OwnerRuleRow): PatternSpec {
  return {
    kind: row.kind === "regex" ? "regex" : "literal",
    pattern: openPattern(row.sealedPattern),
    matchCase: row.matchCase,
    wholeWord: row.wholeWord,
  }
}

async function liveRules(ownerKey: string, where: { enabled?: boolean } = {}) {
  return prisma.ownerRule.findMany({
    where: {
      userFingerprint: ownerKey,
      expiresAt: { gt: new Date() },
      ...where,
    },
    orderBy: { createdAt: "asc" },
  })
}

/** Everything an owner has, readable, with how far each has reached. */
export async function listOwnerRules(
  ownerKey: string
): Promise<OwnerRuleView[]> {
  const rules = await liveRules(ownerKey)
  if (rules.length === 0) return []

  const copies = await prisma.globalRule.findMany({
    where: { ownerRuleId: { in: rules.map((rule) => rule.id) } },
    select: { id: true, ownerRuleId: true },
  })
  const produced = copies.length
    ? await prisma.redaction.groupBy({
        by: ["ruleId"],
        where: { ruleId: { in: copies.map((copy) => copy.id) } },
        _count: { _all: true },
      })
    : []
  const perCopy = new Map(produced.map((row) => [row.ruleId, row._count._all]))

  return rules.map((rule) => {
    const mine = copies.filter((copy) => copy.ownerRuleId === rule.id)
    const spec = specFromRow(rule)
    return {
      id: rule.id,
      ...spec,
      category: rule.category,
      enabled: rule.enabled,
      createdAt: rule.createdAt.toISOString(),
      expiresAt: rule.expiresAt.toISOString(),
      originDocumentId: rule.originDocumentId,
      documents: mine.length,
      redactions: mine.reduce(
        (total, copy) => total + (perCopy.get(copy.id) ?? 0),
        0
      ),
    }
  })
}

export class OwnerRuleLimitError extends Error {
  constructor() {
    super(
      `You can keep up to ${OWNER_RULE_LIMIT} global rules. Remove one first.`
    )
    this.name = "OwnerRuleLimitError"
  }
}

/**
 * Creates a global rule and applies it to the document it was decided in.
 *
 * The document in front of the reviewer gets the rule now, because that is
 * where they are looking. Every document they upload afterwards gets it at the
 * end of processing. Documents already open elsewhere are left alone: a rule
 * about the future quietly rewriting reviews already under way would be a
 * decision nobody took.
 */
export async function createOwnerRule(input: {
  ownerKey: string
  spec: PatternSpec
  category: string
  origin: RuleTarget
}): Promise<{ ownerRuleId: string; redactions: Redaction[] }> {
  const count = await prisma.ownerRule.count({
    where: { userFingerprint: input.ownerKey, expiresAt: { gt: new Date() } },
  })
  if (count >= OWNER_RULE_LIMIT) throw new OwnerRuleLimitError()

  const spec = compilePattern(input.spec).spec
  const ownerRuleId = newOwnerRuleId()
  const plan = await planRule({
    target: input.origin,
    spec,
    category: input.category,
    reason: ownerRuleReason(spec),
    ownerRuleId,
  })

  const now = new Date()
  await prisma.$transaction([
    prisma.ownerRule.create({
      data: {
        id: ownerRuleId,
        userFingerprint: input.ownerKey,
        kind: spec.kind,
        sealedPattern: sealPattern(spec.pattern),
        matchCase: spec.matchCase,
        wholeWord: spec.wholeWord,
        category: input.category,
        originDocumentId: input.origin.id,
        lastUsedAt: now,
        expiresAt: idleExpiry(now),
      },
    }),
    ...planWrites([plan]),
  ])

  return { ownerRuleId, redactions: plan.redactions }
}

/**
 * Applies every global rule this document has not seen yet.
 *
 * Run at the end of processing beside `carryBatchRules`, with the same
 * guarantee: a copy already materialized is skipped, so a retried step does
 * not double anything. Each rule it applies is marked used, which is what
 * keeps a rule that is still doing its job from expiring.
 */
export async function carryOwnerRules(
  documentId: string
): Promise<{ rulesApplied: number; redactions: number }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { ...RULE_TARGET_SELECT, userFingerprint: true },
  })
  const target = document ? asTarget(document) : null
  if (!document || !target) return { rulesApplied: 0, redactions: 0 }

  const [rules, existing] = await Promise.all([
    liveRules(document.userFingerprint, { enabled: true }),
    prisma.globalRule.findMany({
      where: { documentId, ownerRuleId: { not: null } },
      select: { ownerRuleId: true },
    }),
  ])
  const already = new Set(existing.map((rule) => rule.ownerRuleId))

  let rulesApplied = 0
  let redactions = 0
  const now = new Date()

  for (const rule of rules) {
    if (already.has(rule.id)) continue
    const spec = specFromRow(rule)
    const plan = await planRule({
      target,
      spec,
      category: rule.category,
      reason: ownerRuleReason(spec),
      ownerRuleId: rule.id,
    })
    await prisma.$transaction([
      ...planWrites([plan]),
      prisma.ownerRule.update({
        where: { id: rule.id },
        data: { lastUsedAt: now, expiresAt: idleExpiry(now) },
      }),
    ])
    rulesApplied += 1
    redactions += plan.redactions.length
  }

  return { rulesApplied, redactions }
}

async function ownedRule(ownerKey: string, ownerRuleId: string) {
  return prisma.ownerRule.findFirst({
    where: {
      id: ownerRuleId,
      userFingerprint: ownerKey,
      expiresAt: { gt: new Date() },
    },
  })
}

/**
 * Switches a global rule off or on, or rewrites it.
 *
 * Off removes the redactions every copy made and stops it reaching new
 * uploads. On, or an edit, re-plans it into every document that holds a copy
 * and replaces those copies in one transaction — the documents it had already
 * reached, not every document the owner has open.
 */
export async function updateOwnerRule(input: {
  ownerKey: string
  ownerRuleId: string
  enabled?: boolean
  spec?: PatternSpec
  category?: string
}): Promise<{ documents: number; redactions: number } | null> {
  const rule = await ownedRule(input.ownerKey, input.ownerRuleId)
  if (!rule) return null

  const spec = input.spec ? compilePattern(input.spec).spec : specFromRow(rule)
  const category = input.category ?? rule.category
  const enabled = input.enabled ?? rule.enabled
  const now = new Date()

  const copies = await prisma.globalRule.findMany({
    where: { ownerRuleId: rule.id },
    select: { id: true, documentId: true, createdAt: true },
  })

  const unredact = prisma.redaction.deleteMany({
    where: { ruleId: { in: copies.map((copy) => copy.id) } },
  })
  const record = prisma.ownerRule.update({
    where: { id: rule.id },
    data: {
      kind: spec.kind,
      sealedPattern: sealPattern(spec.pattern),
      matchCase: spec.matchCase,
      wholeWord: spec.wholeWord,
      category,
      enabled,
      lastUsedAt: now,
      expiresAt: idleExpiry(now),
    },
  })

  if (!enabled) {
    // The copies stay, switched off, so switching the rule back on knows which
    // documents it had reached.
    await prisma.$transaction([
      unredact,
      prisma.globalRule.updateMany({
        where: { ownerRuleId: rule.id },
        data: { enabled: false },
      }),
      record,
    ])
    return { documents: 0, redactions: 0 }
  }

  const documents = await prisma.document.findMany({
    where: {
      id: { in: copies.map((copy) => copy.documentId) },
      expiresAt: { gt: now },
    },
    select: RULE_TARGET_SELECT,
  })

  const plans = []
  for (const row of documents) {
    const target = asTarget(row)
    if (!target) continue
    plans.push(
      await planRule({
        target,
        spec,
        category,
        reason: ownerRuleReason(spec),
        ownerRuleId: rule.id,
        createdAt: copies.find((copy) => copy.documentId === row.id)?.createdAt,
      })
    )
  }

  await prisma.$transaction([
    unredact,
    prisma.globalRule.deleteMany({ where: { ownerRuleId: rule.id } }),
    record,
    ...planWrites(plans),
  ])

  return {
    documents: plans.length,
    redactions: plans.reduce(
      (total, plan) => total + plan.redactions.length,
      0
    ),
  }
}

/** Removes a global rule and every redaction it made, in every document. */
export async function removeOwnerRule(
  ownerKey: string,
  ownerRuleId: string
): Promise<{ documents: number; redactions: number } | null> {
  const rule = await ownedRule(ownerKey, ownerRuleId)
  if (!rule) return null

  const copies = await prisma.globalRule.findMany({
    where: { ownerRuleId: rule.id },
    select: { id: true },
  })

  const [removed] = await prisma.$transaction([
    prisma.redaction.deleteMany({
      where: { ruleId: { in: copies.map((copy) => copy.id) } },
    }),
    prisma.globalRule.deleteMany({ where: { ownerRuleId: rule.id } }),
    prisma.ownerRule.delete({ where: { id: rule.id } }),
  ])

  return { documents: copies.length, redactions: removed.count }
}

/** Removes rules nobody has used for the idle window. Run by the cleanup sweep. */
export async function pruneOwnerRules(now: Date = new Date()): Promise<number> {
  const result = await prisma.ownerRule.deleteMany({
    where: { expiresAt: { lte: now } },
  })
  return result.count
}

// --- export and import --------------------------------------------------------

export const RULE_FILE_FORMAT = "anonify.rules"
export const RULE_FILE_VERSION = 1

const ruleFileEntry = z.object({
  kind: z.enum(PATTERN_KINDS),
  pattern: z.string().min(1).max(PATTERN_MAX_LENGTH),
  matchCase: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
  category: z.string().min(1).max(60),
  enabled: z.boolean().default(true),
})

export const ruleFileSchema = z.object({
  format: z.literal(RULE_FILE_FORMAT),
  version: z.literal(RULE_FILE_VERSION),
  rules: z.array(ruleFileEntry).max(OWNER_RULE_LIMIT),
})

export type RuleFile = z.infer<typeof ruleFileSchema>

/**
 * A rule set as a file somebody can keep, share, or import elsewhere.
 *
 * Patterns only — no counts, no document ids, no dates. The file travels to
 * other instances and other people, and nothing about which documents a rule
 * matched is theirs to know.
 */
export async function exportOwnerRules(ownerKey: string): Promise<RuleFile> {
  const rules = await liveRules(ownerKey)
  return {
    format: RULE_FILE_FORMAT,
    version: RULE_FILE_VERSION,
    rules: rules.map((rule) => {
      const spec = specFromRow(rule)
      return {
        kind: spec.kind,
        pattern: spec.pattern,
        matchCase: spec.matchCase,
        wholeWord: spec.wholeWord,
        category: rule.category,
        enabled: rule.enabled,
      }
    }),
  }
}

export type ImportResult = {
  imported: number
  /** Already present with the same pattern, options and category. */
  duplicates: number
  /** Refused by the compiler, with the reason, by position in the file. */
  invalid: { index: number; problem: string }[]
}

function sameRule(a: RuleFile["rules"][number], b: RuleFile["rules"][number]) {
  return (
    a.kind === b.kind &&
    a.pattern === b.pattern &&
    a.matchCase === b.matchCase &&
    a.wholeWord === b.wholeWord &&
    a.category === b.category
  )
}

/**
 * Adds a rule file's rules to an owner's set.
 *
 * Every pattern is compiled here, by the same compiler the rules will run
 * under, and one that fails is reported rather than stored: a rule file is
 * input from elsewhere, and a RegEx this instance refuses must not wait in the
 * database to fail on somebody's next upload. Imported rules apply to future
 * uploads only, like any global rule; nothing already open changes.
 */
export async function importOwnerRules(
  ownerKey: string,
  file: RuleFile
): Promise<ImportResult> {
  const existing = (await exportOwnerRules(ownerKey)).rules
  const invalid: ImportResult["invalid"] = []
  const accepted: RuleFile["rules"] = []
  let duplicates = 0

  file.rules.forEach((entry, index) => {
    try {
      compilePattern(entry)
    } catch (error) {
      invalid.push({
        index,
        problem:
          error instanceof Error ? error.message : "Not a valid pattern.",
      })
      return
    }
    if ([...existing, ...accepted].some((other) => sameRule(other, entry))) {
      duplicates += 1
      return
    }
    accepted.push(entry)
  })

  if (existing.length + accepted.length > OWNER_RULE_LIMIT) {
    throw new OwnerRuleLimitError()
  }

  const now = new Date()
  if (accepted.length > 0) {
    await prisma.ownerRule.createMany({
      data: accepted.map((entry) => ({
        id: newOwnerRuleId(),
        userFingerprint: ownerKey,
        kind: entry.kind,
        sealedPattern: sealPattern(entry.pattern),
        matchCase: entry.matchCase,
        wholeWord: entry.wholeWord,
        category: entry.category,
        enabled: entry.enabled,
        lastUsedAt: now,
        expiresAt: idleExpiry(now),
      })),
    })
  }

  return { imported: accepted.length, duplicates, invalid }
}
