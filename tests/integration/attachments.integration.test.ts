import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * Expanding a message into a batch, against a real database.
 *
 * Three of the four things this has to get right are properties of rows rather
 * than of functions, and a fake would agree with whatever the code did:
 *
 *   - a child exists per supported attachment, addressed by part path;
 *   - the upload allowance is charged once per child and *stays* once across a
 *     retry that re-parses the message from scratch;
 *   - an attachment the allowance does not cover is still a row somebody can
 *     see, carrying the reason they would have got at upload time.
 *
 * The fourth is what the message's own export then carries, which is where the
 * dispositions are decided — also a join against these rows.
 */

const { prisma } = await import("@/lib/database/prisma")
const { expandContainer: expandMessageAttachments } = await import(
  "@/lib/documents/expand"
)
const { resolveAttachments } = await import("@/lib/redaction/attachments")
const { putObject, sourceKey } = await import("@/lib/storage/blob")
const { encryptDocument } = await import("@/lib/storage/encryption")
const { sha256 } = await import("@/lib/storage/integrity")
const { attachedEml, bytesOf, unreadableBytes } = await import(
  "../eml-fixtures"
)
const { makeDocxFixture, makePdfFixture } = await import("../fixtures")

const QUOTA_ENV = ["ANONIFY_PROFILE", "ANONIFY_QUOTA_UPLOADS"]

const pdf = await makePdfFixture()
const docx = await makeDocxFixture()

const owners: string[] = []

function owner(label: string): string {
  const value = testFingerprint(label)
  owners.push(value)
  return value
}

/** A message already ingested: sealed source, checksum, no children yet. */
async function seedMessage(input: {
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
      originalName: "message.eml",
      kind: "eml",
      mimeType: "message/rfc822",
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
    orderBy: { sourcePartPath: "asc" },
  })
}

describe.skipIf(!hasDatabase)("expanding a message against Postgres", () => {
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
      // Children first would be tidier; the cascade on parentDocumentId means
      // deleting by owner takes them either way.
      await prisma.document.deleteMany({ where: { userFingerprint: value } })
      await prisma.usageRecord.deleteMany({ where: { fingerprint: value } })
      await prisma.batch.deleteMany({ where: { userFingerprint: value } })
    }
  })

  it("makes one child per supported attachment, addressed by part path", async () => {
    const ownerKey = owner("expand")
    const id = await seedMessage({
      ownerKey,
      source: attachedEml([
        { contentType: "application/pdf", filename: "report.pdf", bytes: pdf },
        {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          filename: "notes.docx",
          bytes: docx,
        },
      ]),
    })

    const summary = await expandMessageAttachments(id)
    expect(summary.expanded).toBe(true)

    const children = await childrenOf(id)
    expect(children.map((child) => child.sourcePartPath)).toEqual(["0.2", "0.3"])
    expect(children.map((child) => child.kind)).toEqual(["pdf", "docx"])
    // Sealed and checksummed like any other ingest, so nothing downstream can
    // tell they arrived inside a message.
    expect(children.every((child) => Boolean(child.sourceBlobKey))).toBe(true)
    expect(children.every((child) => Boolean(child.encryptionKey))).toBe(true)
    expect(children.every((child) => child.status === "queued")).toBe(true)
  })

  it("creates a batch for a message that arrived on its own", async () => {
    const ownerKey = owner("batch")
    const id = await seedMessage({
      ownerKey,
      source: attachedEml([
        { contentType: "application/pdf", filename: "report.pdf", bytes: pdf },
      ]),
    })

    const summary = await expandMessageAttachments(id)
    expect(summary.batchId).toBeTruthy()

    const parent = await prisma.document.findUnique({ where: { id } })
    expect(parent?.batchId).toBe(summary.batchId)

    const children = await childrenOf(id)
    expect(children.every((child) => child.batchId === summary.batchId)).toBe(
      true
    )
  })

  it("keeps the batch a message already arrived in", async () => {
    const ownerKey = owner("existing-batch")
    const batchId = testId("bat")
    await prisma.batch.create({
      data: { id: batchId, userFingerprint: ownerKey },
    })

    const id = await seedMessage({
      ownerKey,
      batchId,
      source: attachedEml([
        { contentType: "application/pdf", filename: "report.pdf", bytes: pdf },
      ]),
    })

    const summary = await expandMessageAttachments(id)
    expect(summary.batchId).toBe(batchId)
  })

  it("charges one upload per child, and charges it once across a retry", async () => {
    const ownerKey = owner("charge")
    const id = await seedMessage({
      ownerKey,
      source: attachedEml([
        { contentType: "application/pdf", filename: "a.pdf", bytes: pdf },
        { contentType: "application/pdf", filename: "b.pdf", bytes: pdf },
      ]),
    })

    await expandMessageAttachments(id)
    expect(await uploadsCharged(ownerKey)).toBe(2)

    // The step is retried and re-parses the message from scratch. Neither the
    // batch nor the bill may grow a second time.
    const again = await expandMessageAttachments(id)
    expect(again.expanded).toBe(false)
    expect(again.children).toHaveLength(2)
    expect(await uploadsCharged(ownerKey)).toBe(2)
    expect(await childrenOf(id)).toHaveLength(2)
  })

  it("does not populate twice when the mark was lost mid-run", async () => {
    const ownerKey = owner("retry")
    const id = await seedMessage({
      ownerKey,
      source: attachedEml([
        { contentType: "application/pdf", filename: "a.pdf", bytes: pdf },
      ]),
    })

    await expandMessageAttachments(id)

    // A crash between the last child and the mark: the children exist, the
    // parent does not know it. The unique constraint is what stops the retry
    // making a second copy, rather than the mark.
    await prisma.document.update({
      where: { id },
      data: { metadata: {} },
    })

    await expandMessageAttachments(id)

    expect(await childrenOf(id)).toHaveLength(1)
    expect(await uploadsCharged(ownerKey)).toBe(1)
  })

  it("keeps an attachment the allowance will not cover, and says why", async () => {
    const ownerKey = owner("quota")
    process.env.ANONIFY_PROFILE = "demo"
    process.env.ANONIFY_QUOTA_UPLOADS = "1"

    const id = await seedMessage({
      ownerKey,
      source: attachedEml([
        { contentType: "application/pdf", filename: "a.pdf", bytes: pdf },
        { contentType: "application/pdf", filename: "b.pdf", bytes: pdf },
      ]),
    })

    await expandMessageAttachments(id)
    const children = await childrenOf(id)

    expect(children).toHaveLength(2)
    expect(children[0].status).toBe("queued")

    // Present, named and explicitly skipped — never silently missing, which
    // would be a reviewer believing they had seen everything.
    expect(children[1].status).toBe("failed")
    expect(children[1].errorCode).toBe("quota")
    expect(children[1].originalName).toBe("b.pdf")
    expect(children[1].error).toMatch(/limit/i)

    expect(await uploadsCharged(ownerKey)).toBe(1)
  })

  it("keeps an attachment whose bytes belie its name, and says why", async () => {
    const ownerKey = owner("mismatch")
    const id = await seedMessage({
      ownerKey,
      source: attachedEml([
        { contentType: "application/pdf", filename: "a.pdf", bytes: pdf },
        // Named .pdf, actually a DOCX. Ingest refuses these, and here that
        // refusal has to be one named child rather than the whole message.
        { contentType: "application/pdf", filename: "review.pdf", bytes: docx },
      ]),
    })

    await expandMessageAttachments(id)
    const children = await childrenOf(id)

    expect(children).toHaveLength(2)
    expect(children[0].status).toBe("queued")
    expect(children[1].status).toBe("failed")
    expect(children[1].errorCode).toBe("extension-mismatch")
    expect(children[1].originalName).toBe("review.pdf")
  })

  it("does not make a child for a format it cannot read", async () => {
    const ownerKey = owner("carry")
    const id = await seedMessage({
      ownerKey,
      source: attachedEml([
        {
          contentType: "application/zip",
          filename: "bundle.zip",
          bytes: unreadableBytes(),
        },
      ]),
    })

    const summary = await expandMessageAttachments(id)

    expect(summary.children).toHaveLength(0)
    expect(summary.carried).toBe(1)
    expect(await childrenOf(id)).toHaveLength(0)
    // No batch either: one document is not a review pass.
    expect(summary.batchId).toBeNull()
  })
})

describe.skipIf(!hasDatabase)("what a message's export carries", () => {
  afterAll(async () => {
    for (const value of owners) {
      await prisma.document.deleteMany({ where: { userFingerprint: value } })
      await prisma.usageRecord.deleteMany({ where: { fingerprint: value } })
      await prisma.batch.deleteMany({ where: { userFingerprint: value } })
    }
  })

  it("names a disposition for every attachment, and removes what is not ready", async () => {
    const ownerKey = owner("dispositions")
    const source = attachedEml([
      { contentType: "application/pdf", filename: "ready.pdf", bytes: pdf },
      { contentType: "application/pdf", filename: "waiting.pdf", bytes: pdf },
      {
        contentType: "application/zip",
        filename: "bundle.zip",
        bytes: unreadableBytes(),
      },
    ])
    const id = await seedMessage({ ownerKey, source })

    await expandMessageAttachments(id)
    const children = await childrenOf(id)
    await prisma.document.update({
      where: { id: children[0].id },
      data: { status: "ready" },
    })

    const redacted = new Uint8Array(Buffer.from("%PDF-1.4\nredacted\n"))
    const { outcomes, substitutions } = await resolveAttachments({
      documentId: id,
      kind: "eml",
      source: bytesOf(source),
      exportChild: async () => ({
        bytes: redacted,
        checksum: sha256(redacted),
        vaultEntries: [],
        vaultKeyUsed: false,
      }),
    })

    expect(outcomes.map((outcome) => outcome.disposition)).toEqual([
      "redacted",
      "removed",
      "carried-through",
    ])
    expect(outcomes.map((outcome) => outcome.partPath)).toEqual([
      "0.2",
      "0.3",
      "0.4",
    ])
    expect(outcomes[1].reason).toMatch(/had not finished processing/)

    // The one that is not ready is taken out rather than shipped as it
    // arrived, and the readable one is replaced with its own redacted export.
    expect(substitutions["0.2"]).toMatchObject({ action: "replace" })
    expect(substitutions["0.3"]).toMatchObject({ action: "remove" })
    expect(substitutions["0.4"]).toBeUndefined()
  })

  it("removes a supported attachment that nothing ever expanded", async () => {
    const ownerKey = owner("legacy")
    const source = attachedEml([
      { contentType: "application/pdf", filename: "orphan.pdf", bytes: pdf },
    ])
    const id = await seedMessage({ ownerKey, source })

    const { outcomes, substitutions } = await resolveAttachments({
      documentId: id,
      kind: "eml",
      source: bytesOf(source),
      exportChild: async () => {
        throw new Error("no child should be exported")
      },
    })

    expect(outcomes[0].disposition).toBe("removed")
    expect(substitutions["0.2"]).toMatchObject({ action: "remove" })
  })

  it("carries no dispositions for a document that is not a message", async () => {
    const ownerKey = owner("not-a-message")
    const id = await seedMessage({
      ownerKey,
      source: attachedEml([
        { contentType: "application/pdf", filename: "a.pdf", bytes: pdf },
      ]),
    })

    const resolved = await resolveAttachments({
      documentId: id,
      kind: "pdf",
      source: pdf,
      exportChild: async () => null,
    })

    expect(resolved.outcomes).toEqual([])
    expect(resolved.substitutions).toEqual({})
  })
})
