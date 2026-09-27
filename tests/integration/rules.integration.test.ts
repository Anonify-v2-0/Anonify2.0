import { afterAll, describe, expect, it } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * Rules against Postgres: that a rule is written whole or not at all, that
 * carrying it is idempotent on retry, that it reaches every scope it claims
 * to, and that removing it takes back everything it did.
 *
 * The things under test only exist in the database — a transaction that must
 * roll back, a copy that must not be written twice — so a fake would agree
 * with whatever the code did.
 */

const { prisma } = await import("@/lib/database/prisma")
const { saveNormalized } = await import("@/lib/documents/normalized-store")
const { newDocumentSeal } = await import("@/lib/storage/sealed")
const { newBatchId } = await import("@/lib/documents/ids")
const rules = await import("@/lib/redaction/rules")
const owned = await import("@/lib/redaction/owner-rules")
const { PatternBudgetError, RULE_MATCH_LIMIT } = await import("@/lib/redaction/patterns")

const owners: string[] = []

function owner(label: string): string {
  const value = testFingerprint(label)
  owners.push(value)
  return value
}

const literal = (pattern: string) => ({
  kind: "literal" as const,
  pattern,
  matchCase: false,
  wholeWord: false,
})

const regex = (pattern: string) => ({
  kind: "regex" as const,
  pattern,
  matchCase: true,
  wholeWord: true,
})

/** A document that has been normalized, which is what a rule needs. */
async function seedDocument(input: {
  ownerKey: string
  text: string
  batchId?: string | null
  normalized?: boolean
}) {
  const id = testId("doc")
  const seal = newDocumentSeal()
  await prisma.document.create({
    data: {
      id,
      originalName: "notes.txt",
      kind: "txt",
      mimeType: "text/plain",
      size: input.text.length,
      status: input.normalized === false ? "analyzing" : "ready",
      userFingerprint: input.ownerKey,
      batchId: input.batchId ?? null,
      encryptionKey: seal.wrappedKey,
      encryptionFormat: seal.format,
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  })
  if (input.normalized !== false) await normalize(id, input.text)
  return id
}

async function normalize(id: string, text: string) {
  const document = await prisma.document.findUniqueOrThrow({
    where: { id },
    select: { encryptionKey: true, encryptionFormat: true },
  })
  const saved = await saveNormalized(
    id,
    { wrappedKey: document.encryptionKey as string, format: document.encryptionFormat as "v1" },
    {
      documentId: id,
      kind: "txt",
      pages: [
        { number: 1, width: 612, height: 792, text, spans: [{ id: "s1", text, start: 0, end: text.length }] },
      ],
    }
  )
  await prisma.document.update({
    where: { id },
    data: { normalizedBlobKey: saved.key, normalizedIndex: saved.index, status: "ready" },
  })
}

async function targetOf(id: string) {
  const row = await prisma.document.findUniqueOrThrow({
    where: { id },
    select: rules.RULE_TARGET_SELECT,
  })
  return rules.asTarget(row)!
}

async function seedBatch(ownerKey: string) {
  const id = newBatchId()
  await prisma.batch.create({ data: { id, userFingerprint: ownerKey } })
  return id
}

const redactionsIn = (documentId: string) =>
  prisma.redaction.findMany({ where: { documentId }, orderBy: { startOffset: "asc" } })

const TEXT = "Staff EMP-00123 and EMP-00456 met Jane. Reference ORDER-99999."

describe.skipIf(!hasDatabase)("rules against Postgres", () => {
  afterAll(async () => {
    for (const value of owners) {
      await prisma.document.deleteMany({ where: { userFingerprint: value } })
      await prisma.batch.deleteMany({ where: { userFingerprint: value } })
      await prisma.ownerRule.deleteMany({ where: { userFingerprint: value } })
    }
  })

  it("applies a RegEx rule as accepted redactions that record the rule", async () => {
    const ownerKey = owner("rules-regex")
    const id = await seedDocument({ ownerKey, text: TEXT })

    const applied = await rules.applyRuleToDocument({
      target: await targetOf(id),
      spec: regex("EMP-\\d{5}"),
      category: "customer-id",
      reason: "test",
    })

    const rows = await redactionsIn(id)
    expect(rows.map((row) => row.text)).toEqual(["EMP-00123", "EMP-00456"])
    expect(rows.every((row) => row.status === "accepted" && row.ruleId === applied.ruleId)).toBe(true)
    const rule = await prisma.globalRule.findUniqueOrThrow({ where: { id: applied.ruleId } })
    expect(rule.kind).toBe("regex")
    expect(rule.normalizedPattern).toBe("EMP-\\d{5}")
  })

  it("writes nothing at all when a rule runs out of budget", async () => {
    const ownerKey = owner("rules-budget")
    const batchId = await seedBatch(ownerKey)
    const small = await seedDocument({ ownerKey, batchId, text: "x marks the spot" })
    const huge = await seedDocument({
      ownerKey,
      batchId,
      text: "x ".repeat(RULE_MATCH_LIMIT + 10),
    })

    await expect(
      rules.createBatchRule({ batchId, spec: literal("x"), category: "other", originDocumentId: small })
    ).rejects.toBeInstanceOf(PatternBudgetError)

    // Not the batch rule, not the copy in the small document it could apply
    // to, not a redaction anywhere: the decision failed as one.
    expect(await prisma.batchRule.count({ where: { batchId } })).toBe(0)
    expect(await prisma.globalRule.count({ where: { documentId: { in: [small, huge] } } })).toBe(0)
    expect(await prisma.redaction.count({ where: { documentId: { in: [small, huge] } } })).toBe(0)
  })

  it("carries a batch RegEx rule into a late document once, however often it is retried", async () => {
    const ownerKey = owner("rules-carry")
    const batchId = await seedBatch(ownerKey)
    const first = await seedDocument({ ownerKey, batchId, text: TEXT })
    const late = await seedDocument({ ownerKey, batchId, text: "", normalized: false })

    const { batchRuleId } = await rules.createBatchRule({
      batchId,
      spec: regex("EMP-\\d{5}"),
      category: "customer-id",
      originDocumentId: first,
    })

    await normalize(late, "Late file: EMP-77777.")
    await rules.carryBatchRules(late)
    await rules.carryBatchRules(late)

    expect(await prisma.globalRule.count({ where: { documentId: late, batchRuleId } })).toBe(1)
    expect((await redactionsIn(late)).map((row) => row.text)).toEqual(["EMP-77777"])
  })

  it("switches a batch rule off and on everywhere, and removes it with its redactions", async () => {
    const ownerKey = owner("rules-toggle")
    const batchId = await seedBatch(ownerKey)
    const a = await seedDocument({ ownerKey, batchId, text: TEXT })
    const b = await seedDocument({ ownerKey, batchId, text: "Also EMP-00999." })
    const { batchRuleId } = await rules.createBatchRule({
      batchId,
      spec: regex("EMP-\\d{5}"),
      category: "customer-id",
      originDocumentId: a,
    })
    expect(await prisma.redaction.count({ where: { documentId: { in: [a, b] } } })).toBe(3)

    await rules.updateBatchRule({ batchId, batchRuleId, enabled: false })
    expect(await prisma.redaction.count({ where: { documentId: { in: [a, b] } } })).toBe(0)

    // A disabled rule is not carried into a document that finishes later.
    const late = await seedDocument({ ownerKey, batchId, text: "EMP-11111" })
    expect((await rules.carryBatchRules(late)).rulesApplied).toBe(0)

    await rules.updateBatchRule({ batchId, batchRuleId, enabled: true })
    expect(await prisma.redaction.count({ where: { documentId: { in: [a, b, late] } } })).toBe(4)

    // An edit re-plans everywhere with the new pattern.
    await rules.updateBatchRule({ batchId, batchRuleId, spec: regex("EMP-00\\d{3}") })
    expect(await prisma.redaction.count({ where: { documentId: { in: [a, b, late] } } })).toBe(3)

    const removed = await rules.removeBatchRule(batchId, batchRuleId)
    expect(removed.redactions).toBe(3)
    expect(await prisma.globalRule.count({ where: { batchRuleId } })).toBe(0)
  })

  it("keeps a global rule's pattern sealed, and carries it into the owner's next upload once", async () => {
    const ownerKey = owner("rules-global")
    const origin = await seedDocument({ ownerKey, text: TEXT })
    const { ownerRuleId } = await owned.createOwnerRule({
      ownerKey,
      spec: literal("Jane"),
      category: "person",
      origin: await targetOf(origin),
    })

    const row = await prisma.ownerRule.findUniqueOrThrow({ where: { id: ownerRuleId } })
    expect(row.sealedPattern).not.toContain("Jane")
    expect(Buffer.from(row.sealedPattern, "base64").toString("utf8")).not.toContain("Jane")
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000)
    expect((await redactionsIn(origin)).map((redaction) => redaction.text)).toEqual(["Jane"])

    const next = await seedDocument({ ownerKey, text: "Jane again, and jane." })
    await owned.carryOwnerRules(next)
    await owned.carryOwnerRules(next)
    expect(await prisma.globalRule.count({ where: { documentId: next, ownerRuleId } })).toBe(1)
    expect(await prisma.redaction.count({ where: { documentId: next } })).toBe(2)

    // Nobody else's upload gets it.
    const stranger = await seedDocument({ ownerKey: owner("rules-stranger"), text: "Jane" })
    expect((await owned.carryOwnerRules(stranger)).rulesApplied).toBe(0)

    const [view] = await owned.listOwnerRules(ownerKey)
    expect(view).toMatchObject({ pattern: "Jane", documents: 2, redactions: 3 })

    const removed = await owned.removeOwnerRule(ownerKey, ownerRuleId)
    expect(removed).toEqual({ documents: 2, redactions: 3 })
    expect(await prisma.redaction.count({ where: { documentId: { in: [origin, next] } } })).toBe(0)
  })

  it("switches a global rule off everywhere it reached, and on again", async () => {
    const ownerKey = owner("rules-global-toggle")
    const origin = await seedDocument({ ownerKey, text: TEXT })
    const { ownerRuleId } = await owned.createOwnerRule({
      ownerKey,
      spec: regex("EMP-\\d{5}"),
      category: "customer-id",
      origin: await targetOf(origin),
    })

    await owned.updateOwnerRule({ ownerKey, ownerRuleId, enabled: false })
    expect(await prisma.redaction.count({ where: { documentId: origin } })).toBe(0)
    const later = await seedDocument({ ownerKey, text: "EMP-55555" })
    expect((await owned.carryOwnerRules(later)).rulesApplied).toBe(0)

    await owned.updateOwnerRule({ ownerKey, ownerRuleId, enabled: true })
    expect(await prisma.redaction.count({ where: { documentId: origin } })).toBe(2)
    // Another owner cannot touch it.
    expect(
      await owned.updateOwnerRule({ ownerKey: owner("rules-other"), ownerRuleId, enabled: false })
    ).toBeNull()
  })

  it("exports rules as a file and imports them elsewhere, refusing what will not compile", async () => {
    const ownerKey = owner("rules-export")
    const origin = await seedDocument({ ownerKey, text: TEXT })
    await owned.createOwnerRule({
      ownerKey,
      spec: regex("EMP-\\d{5}"),
      category: "customer-id",
      origin: await targetOf(origin),
    })

    const file = await owned.exportOwnerRules(ownerKey)
    expect(file).toEqual({
      format: "anonify.rules",
      version: 1,
      rules: [
        {
          kind: "regex",
          pattern: "EMP-\\d{5}",
          matchCase: true,
          wholeWord: true,
          category: "customer-id",
          enabled: true,
        },
      ],
    })

    const elsewhere = owner("rules-import")
    const result = await owned.importOwnerRules(elsewhere, {
      ...file,
      rules: [
        ...file.rules,
        { ...file.rules[0] },
        { kind: "regex", pattern: "(a)\\1", matchCase: false, wholeWord: false, category: "other", enabled: true },
      ],
    })
    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(1)
    expect(result.invalid).toEqual([{ index: 2, problem: expect.stringMatching(/backreferences/i) }])
    expect((await owned.listOwnerRules(elsewhere)).map((rule) => rule.pattern)).toEqual([
      "EMP-\\d{5}",
    ])
  })

  it("prunes a global rule nobody has used for the idle window", async () => {
    const ownerKey = owner("rules-prune")
    await owned.importOwnerRules(ownerKey, {
      format: "anonify.rules",
      version: 1,
      rules: [{ kind: "literal", pattern: "Jane", matchCase: false, wholeWord: false, category: "person", enabled: true }],
    })
    await prisma.ownerRule.updateMany({
      where: { userFingerprint: ownerKey },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(await owned.listOwnerRules(ownerKey)).toEqual([])
    expect(await owned.pruneOwnerRules()).toBeGreaterThanOrEqual(1)
    expect(await prisma.ownerRule.count({ where: { userFingerprint: ownerKey } })).toBe(0)
  })
})
