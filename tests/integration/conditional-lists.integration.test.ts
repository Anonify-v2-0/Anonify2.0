import { afterAll, describe, expect, it, vi } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

const caller = vi.hoisted(() => ({
  ownerKey: "",
  networkKey: `test_lists_network_${Math.random().toString(16).slice(2)}`,
}))
vi.mock("@/lib/security/fingerprint", () => {
  const identity = async () => ({
    sessionId: "test-session",
    normalizedIp: "unknown",
    ownerKey: caller.ownerKey,
    quotaKey: caller.ownerKey,
    networkKey: caller.networkKey,
  })
  return {
    peekIdentity: identity,
    renewIdentity: identity,
    getIdentity: identity,
  }
})

/**
 * The document list and the batch view answer 304 when nothing they draw has
 * changed (#177), and only the caller's own documents decide that.
 */

const { prisma } = await import("@/lib/database/prisma")
const { newBatchId } = await import("@/lib/documents/ids")
const documentsRoute = await import("@/app/api/documents/route")
const batchRoute = await import("@/app/api/batches/[id]/route")

const owners: string[] = []

function owner(label: string) {
  const value = testFingerprint(label)
  owners.push(value)
  return value
}

async function seedDocument(ownerKey: string, batchId: string | null = null) {
  const id = testId("doc")
  await prisma.document.create({
    data: {
      id,
      originalName: "notes.txt",
      kind: "txt",
      mimeType: "text/plain",
      size: 10,
      status: "analyzing",
      userFingerprint: ownerKey,
      batchId,
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  })
  return id
}

function get(url: string, etag?: string | null) {
  return new Request(`http://localhost${url}`, {
    headers: etag ? { "if-none-match": etag } : {},
  })
}

async function listAs(ownerKey: string, etag?: string | null) {
  caller.ownerKey = ownerKey
  return documentsRoute.GET(get("/api/documents", etag))
}

async function batchAs(ownerKey: string, id: string, etag?: string | null) {
  caller.ownerKey = ownerKey
  return batchRoute.GET(get(`/api/batches/${id}`, etag), {
    params: Promise.resolve({ id }),
  })
}

describe.skipIf(!hasDatabase)("conditional list responses", () => {
  afterAll(async () => {
    for (const value of owners) {
      await prisma.document.deleteMany({ where: { userFingerprint: value } })
      await prisma.batch.deleteMany({ where: { userFingerprint: value } })
    }
    await prisma.rateLimit.deleteMany({
      where: { key: { endsWith: caller.networkKey } },
    })
  })

  it("answers the document list with 304 until one of the caller's documents changes", async () => {
    const mine = owner("lists_mine")
    const theirs = owner("lists_theirs")
    const document = await seedDocument(mine)
    const other = await seedDocument(theirs)

    const first = await listAs(mine)
    expect(first.status).toBe(200)
    const tag = first.headers.get("etag")
    expect(tag).toBeTruthy()

    expect((await listAs(mine, tag)).status).toBe(304)

    // Somebody else's work never moves the caller's tag.
    await prisma.document.update({
      where: { id: other },
      data: { status: "ready" },
    })
    await seedDocument(theirs)
    expect((await listAs(mine, tag)).status).toBe(304)

    await prisma.document.update({
      where: { id: document },
      data: { status: "ready" },
    })
    const changed = await listAs(mine, tag)
    expect(changed.status).toBe(200)
    expect(changed.headers.get("etag")).not.toBe(tag)
    const payload = (await changed.json()) as {
      documents: { id: string; status: string }[]
    }
    expect(payload.documents).toEqual([
      expect.objectContaining({ id: document, status: "ready" }),
    ])
  })

  it("moves the tag when a redaction count changes, though no document row did", async () => {
    const mine = owner("lists_counts")
    const document = await seedDocument(mine)

    const tag = (await listAs(mine)).headers.get("etag")
    await prisma.redaction.create({
      data: {
        id: testId("red"),
        documentId: document,
        page: 1,
        type: "text",
        category: "PERSON",
        source: "manual",
        status: "accepted",
        startOffset: 0,
        endOffset: 4,
        text: "Jane",
      },
    })

    expect((await listAs(mine, tag)).status).toBe(200)
  })

  it("answers the batch view with 304 until the batch changes, after the ownership check", async () => {
    const mine = owner("lists_batch")
    const stranger = owner("lists_stranger")
    const batchId = newBatchId()
    await prisma.batch.create({ data: { id: batchId, userFingerprint: mine } })
    const document = await seedDocument(mine, batchId)

    const first = await batchAs(mine, batchId)
    expect(first.status).toBe(200)
    const tag = first.headers.get("etag")

    expect((await batchAs(mine, batchId, tag)).status).toBe(304)
    // A tag is no way round ownership.
    expect((await batchAs(stranger, batchId, tag)).status).toBe(404)
    expect((await batchAs(stranger, batchId, "*")).status).toBe(404)

    await prisma.document.update({
      where: { id: document },
      data: { status: "failed" },
    })
    expect((await batchAs(mine, batchId, tag)).status).toBe(200)
  })
})
