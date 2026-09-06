import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * Expanding a mailbox into a batch, against a real database.
 *
 * The unit suite proves the split: the same number of messages out as in, no
 * message fractured on a body line, every byte accounted for. What it cannot
 * prove is everything that only exists as a row, and for a mailbox those are
 * the properties that actually decide whether this is safe to ship:
 *
 *   - one child per message, addressed by message index, so a retry lands on
 *     the child it already made rather than a second copy of it;
 *   - the upload allowance charged once per message and *staying* once across
 *     a retry that re-splits the mailbox from scratch — nine hundred messages
 *     is nine hundred charges, and a retry that doubled them would empty an
 *     allowance in one run;
 *   - a message the allowance does not cover present, named and explicitly
 *     skipped. At this scale that matters more than anywhere else in the
 *     codebase: nobody scrolls a nine-hundred-row batch counting, so a message
 *     missing with no row for it is a reviewer believing they have seen
 *     everything at the one moment they cannot check;
 *   - a decision taken on the first message reaching a message that had not
 *     finished processing when it was made. That is the whole reason a mailbox
 *     is worth supporting, and it is a join across three tables.
 */

const { prisma } = await import("@/lib/database/prisma")
const { expandContainer } = await import("@/lib/documents/expand")
const { createBatchRule, carryBatchRules } =
  await import("@/lib/redaction/rules")
const { saveNormalized } = await import("@/lib/documents/normalized-store")
const { putObject, sourceKey } = await import("@/lib/storage/blob")
const { encryptDocument } = await import("@/lib/storage/encryption")
const { sha256 } = await import("@/lib/storage/integrity")
const { bytesOf, EML } = await import("../eml-fixtures")
const { mailbox, mailboxOf, numberedMessage } = await import("../mbox-fixtures")

const QUOTA_ENV = ["ANONIFY_PROFILE", "ANONIFY_QUOTA_UPLOADS"]

const owners: string[] = []

function owner(label: string): string {
  const value = testFingerprint(label)
  owners.push(value)
  return value
}

/** A mailbox already ingested: sealed source, checksum, no children yet. */
async function seedMailbox(input: {
  source: string
  ownerKey: string
  quotaKey?: string | null
  batchId?: string | null
}): Promise<string> {
  const id = testId("doc")
  const bytes = bytesOf(input.source)
  const { ciphertext, wrappedKey } = encryptDocument(bytes)
  const stored = await putObject(sourceKey(id), ciphertext)

  await prisma.document.create({
    data: {
      id,
      originalName: "archive.mbox",
      kind: "mbox",
      mimeType: "application/mbox",
      size: bytes.byteLength,
      status: "queued",
      userFingerprint: input.ownerKey,
      quotaKey: input.quotaKey === undefined ? input.ownerKey : input.quotaKey,
      batchId: input.batchId ?? null,
      sourceBlobKey: stored.key,
      encryptionKey: wrappedKey,
      checksum: sha256(bytes),
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  })

  return id
}

function today(): Date {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
}

async function uploadsCharged(fingerprint: string): Promise<number> {
  const row = await prisma.usageRecord.findUnique({
    where: { fingerprint_date: { fingerprint, date: today() } },
  })
  return row?.uploads ?? 0
}

async function childrenOf(documentId: string) {
  return prisma.document.findMany({
    where: { parentDocumentId: documentId },
    orderBy: { createdAt: "asc" },
  })
}

/**
 * Gives a child the normalized model a carried decision needs to search.
 *
 * The real pipeline writes this during the child's own run. Standing it in
 * here keeps the test about what it is about — whether the decision reaches a
 * document that arrived out of a mailbox — rather than about extraction.
 */
async function normalize(documentId: string, text: string): Promise<void> {
  const document = await prisma.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { encryptionKey: true },
  })

  const key = await saveNormalized(documentId, document.encryptionKey ?? "", {
    documentId,
    kind: "eml",
    pages: [
      {
        number: 1,
        width: 612,
        height: 792,
        text,
        spans: [{ id: "s1", text, start: 0, end: text.length }],
      },
    ],
  })

  await prisma.document.update({
    where: { id: documentId },
    data: { normalizedBlobKey: key, status: "ready" },
  })
}

describe.skipIf(!hasDatabase)("expanding a mailbox against Postgres", () => {
  const saved = new Map<string, string | undefined>()

  beforeAll(() => {
    for (const key of QUOTA_ENV) saved.set(key, process.env[key])
  })

  afterEach(() => {
    for (const key of QUOTA_ENV) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  afterAll(async () => {
    for (const value of owners) {
      await prisma.document.deleteMany({ where: { userFingerprint: value } })
      await prisma.usageRecord.deleteMany({ where: { fingerprint: value } })
      await prisma.batch.deleteMany({ where: { userFingerprint: value } })
    }
  })

  it("makes one child per message, addressed by message index", async () => {
    const ownerKey = owner("mbox-expand")
    const id = await seedMailbox({ ownerKey, source: mailboxOf(6) })

    const summary = await expandContainer(id)

    expect(summary.container).toBe(true)
    expect(summary.expanded).toBe(true)
    expect(summary.children).toHaveLength(6)
    expect(summary.batchId).not.toBeNull()

    const children = await childrenOf(id)
    expect(children.map((child) => child.sourcePartPath)).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
      "msg-5",
    ])
    // Each one indistinguishable from a directly-uploaded message: its own
    // kind, its own sealed bytes, its own key, its own checksum.
    for (const child of children) {
      expect(child.kind).toBe("eml")
      expect(child.status).toBe("queued")
      expect(child.sourceBlobKey).toBeTruthy()
      expect(child.encryptionKey).toBeTruthy()
      expect(child.checksum).toHaveLength(64)
      expect(child.batchId).toBe(summary.batchId)
    }
    // Names come from the position, never from the subject line.
    expect(children.map((child) => child.originalName)).toEqual([
      "message-0001.eml",
      "message-0002.eml",
      "message-0003.eml",
      "message-0004.eml",
      "message-0005.eml",
      "message-0006.eml",
    ])
  })

  it("keeps a mailbox that arrived in a batch in that batch", async () => {
    const ownerKey = owner("mbox-batch")
    const batchId = testId("batch")
    await prisma.batch.create({
      data: { id: batchId, userFingerprint: ownerKey },
    })

    const id = await seedMailbox({ ownerKey, source: mailboxOf(2), batchId })
    const summary = await expandContainer(id)

    // A second batch would stop the reviewer's decisions reaching the messages.
    expect(summary.batchId).toBe(batchId)
  })

  it("charges one upload per message, and charges it once across a retry", async () => {
    const ownerKey = owner("mbox-charge")
    const id = await seedMailbox({ ownerKey, source: mailboxOf(4) })

    await expandContainer(id)
    expect(await uploadsCharged(ownerKey)).toBe(4)

    // The step is retried and re-splits the mailbox from scratch. Neither the
    // batch nor the bill may grow a second time.
    const again = await expandContainer(id)
    expect(again.expanded).toBe(false)
    expect(again.children).toHaveLength(4)
    expect(await uploadsCharged(ownerKey)).toBe(4)
    expect(await childrenOf(id)).toHaveLength(4)
  })

  it("does not populate twice when the mark was lost mid-run", async () => {
    const ownerKey = owner("mbox-retry")
    const id = await seedMailbox({ ownerKey, source: mailboxOf(3) })

    await expandContainer(id)

    // A crash between the last child and the mark: the children exist, the
    // parent does not know it. `(parentDocumentId, sourcePartPath)` is what
    // stops the retry making a second copy, rather than the mark — which is
    // why the part path has to be the message index and not anything the
    // message itself chose.
    await prisma.document.update({ where: { id }, data: { metadata: {} } })

    await expandContainer(id)

    expect(await childrenOf(id)).toHaveLength(3)
    expect(await uploadsCharged(ownerKey)).toBe(3)
  })

  it("keeps a message the allowance will not cover, and says why", async () => {
    const ownerKey = owner("mbox-quota")
    process.env.ANONIFY_PROFILE = "demo"
    process.env.ANONIFY_QUOTA_UPLOADS = "2"

    const id = await seedMailbox({ ownerKey, source: mailboxOf(5) })
    await expandContainer(id)

    const children = await childrenOf(id)

    // Five rows for five messages. The mailbox does not shrink to fit the
    // allowance; the messages it could not afford say so.
    expect(children).toHaveLength(5)
    expect(children.filter((child) => child.status === "queued")).toHaveLength(
      2
    )

    const skipped = children.filter((child) => child.status === "failed")
    expect(skipped).toHaveLength(3)
    for (const child of skipped) {
      expect(child.errorCode).toBe("quota")
      expect(child.error).toBeTruthy()
      // Named, and named by position, so a reviewer can say which ones.
      expect(child.originalName).toMatch(/^message-\d+\.eml$/)
    }
  })

  it("carries a decision from the first message to the nine hundredth", async () => {
    // The reason a mailbox is worth supporting. A name answered once has to
    // reach a message that was still being processed when the answer was
    // given, or the carried-decisions machinery is doing nothing at this scale.
    const ownerKey = owner("mbox-rules")
    const id = await seedMailbox({
      ownerKey,
      source: mailbox([
        numberedMessage(1),
        numberedMessage(2),
        numberedMessage(3),
      ]),
    })

    const summary = await expandContainer(id)
    const batchId = summary.batchId
    expect(batchId).not.toBeNull()

    const children = await childrenOf(id)
    const body = `You can reach ${EML.person} on ${EML.phone}.`

    // The first two have finished; the third has not, which is the whole point.
    await normalize(children[0].id, body)
    await normalize(children[1].id, body)

    const rule = await createBatchRule({
      batchId: batchId as string,
      pattern: EML.person,
      category: "person",
      originDocumentId: children[0].id,
    })

    expect(rule.applied.map((entry) => entry.documentId).sort()).toEqual(
      [children[0].id, children[1].id].sort()
    )

    // The third finishes later and inherits the decision on arrival, which is
    // the path `carryBatchRules` exists for.
    await normalize(children[2].id, body)
    const carried = await carryBatchRules(children[2].id)

    expect(carried.rulesApplied).toBe(1)
    expect(carried.redactions).toBeGreaterThan(0)

    const applied = await prisma.globalRule.count({
      where: { batchRuleId: rule.batchRuleId },
    })
    expect(applied).toBe(3)
  })
})
