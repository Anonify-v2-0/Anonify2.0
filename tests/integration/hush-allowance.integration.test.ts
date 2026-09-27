import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * Hush's per-visitor allowance, through the route, against Postgres.
 *
 * The model is scripted and reports 15 tokens a step; everything else — the
 * route, the agent loop, the usage rows, the allowance — is what ships. What
 * is held down: every step is charged to the visitor, a visitor whose
 * allowance is spent is refused before the model is asked anything, and a run
 * that spends it stops at the next step rather than running on to twelve.
 */

type Step = { tool?: string; text?: string }

let script: Step[] = []
let calls = 0

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function scriptedModel() {
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = script[calls] ?? { text: "Done." }
      calls += 1
      const body = step.tool
        ? [
            {
              type: "tool-call" as const,
              toolCallId: `call_${calls}`,
              toolName: step.tool,
              input: "{}",
            },
          ]
        : [
            { type: "text-start" as const, id: "t" },
            { type: "text-delta" as const, id: "t", delta: step.text ?? "" },
            { type: "text-end" as const, id: "t" },
          ]
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            ...body,
            {
              type: "finish" as const,
              finishReason: step.tool
                ? { unified: "tool-calls" as const, raw: "tool_calls" }
                : { unified: "stop" as const, raw: "stop" },
              usage,
            },
          ],
        }),
      }
    },
  })
}

vi.mock("@/lib/ai/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/providers")>()),
  languageModel: async () => scriptedModel(),
}))

// Whether a provider is configured is the environment's business, not this
// test's; the allowance and the spend check are the real ones.
vi.mock("@/lib/assistant/hush", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/hush")>()),
  hushStatus: async () => ({
    available: true,
    model: "mock",
    provider: { id: "mock", label: "Mock", kind: "local", model: "mock" },
  }),
}))

let identity = {
  sessionId: "",
  normalizedIp: "",
  ownerKey: "",
  quotaKey: "",
  networkKey: "",
}

vi.mock("@/lib/security/fingerprint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/fingerprint")>()),
  peekIdentity: async () => identity,
}))

const { prisma } = await import("@/lib/database/prisma")
const { saveNormalized } = await import("@/lib/documents/normalized-store")
const { newDocumentSeal } = await import("@/lib/storage/sealed")
const { HUSH_ALLOWANCE_MESSAGE } = await import("@/lib/assistant/hush")
const { POST } = await import("@/app/api/documents/[id]/assistant/route")

const TEXT = "Staff EMP-00123 and EMP-00456."
const ENV = "ANONIFY_QUOTA_ASSISTANT_TOKENS"
const documents: string[] = []
const identities: (typeof identity)[] = []

async function seed(): Promise<string> {
  const id = testId("doc")
  documents.push(id)
  const seal = newDocumentSeal()
  await prisma.document.create({
    data: {
      id,
      originalName: "notes.txt",
      kind: "txt",
      mimeType: "text/plain",
      size: TEXT.length,
      status: "ready",
      userFingerprint: identity.ownerKey,
      encryptionKey: seal.wrappedKey,
      encryptionFormat: seal.format,
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  })
  const saved = await saveNormalized(id, seal, {
    documentId: id,
    kind: "txt",
    pages: [
      {
        number: 1,
        width: 612,
        height: 792,
        text: TEXT,
        spans: [{ id: "s1", text: TEXT, start: 0, end: TEXT.length }],
      },
    ],
  })
  await prisma.document.update({
    where: { id },
    data: { normalizedBlobKey: saved.key, normalizedIndex: saved.index },
  })
  return id
}

function ask(documentId: string): Promise<Response> {
  const request = new Request(
    `http://localhost/api/documents/${documentId}/assistant`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "What is in this document?" }],
          },
        ],
        readConsent: true,
      }),
    }
  )
  return POST(request, { params: Promise.resolve({ id: documentId }) })
}

async function tokensCharged(): Promise<number> {
  const rows = await prisma.usageRecord.findMany({
    where: { fingerprint: identity.quotaKey },
  })
  return rows.reduce((total, row) => total + row.assistantTokens, 0)
}

describe.skipIf(!hasDatabase)("Hush's daily allowance", () => {
  const previous = process.env[ENV]

  beforeEach(() => {
    const label = testFingerprint("hush-allowance")
    identity = {
      sessionId: label,
      normalizedIp: "127.0.0.1",
      ownerKey: `${label}_owner`,
      quotaKey: `${label}_quota`,
      networkKey: `${label}_network`,
    }
    identities.push(identity)
  })

  afterEach(() => {
    script = []
    calls = 0
    if (previous === undefined) delete process.env[ENV]
    else process.env[ENV] = previous
  })

  afterAll(async () => {
    await prisma.aiUsage.deleteMany({
      where: { documentId: { in: documents } },
    })
    await prisma.document.deleteMany({ where: { id: { in: documents } } })
    await prisma.usageRecord.deleteMany({
      where: { fingerprint: { in: identities.map((each) => each.quotaKey) } },
    })
    await prisma.rateLimit.deleteMany({
      where: {
        key: {
          in: identities.map((each) => `processing:${each.networkKey}`),
        },
      },
    })
  })

  it("charges every step's tokens to the visitor", async () => {
    process.env[ENV] = "1000"
    const id = await seed()
    script = [{ tool: "get_document_overview" }, { text: "A staff list." }]

    const response = await ask(id)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("A staff list.")

    expect(calls).toBe(2)
    expect(await tokensCharged()).toBe(30)
    const rows = await prisma.aiUsage.findMany({
      where: { documentId: id, task: "assistant" },
    })
    expect(rows).toHaveLength(2)
  })

  it("refuses a second run once the allowance is spent, without asking the model", async () => {
    process.env[ENV] = "10"
    const id = await seed()
    script = [{ text: "A staff list." }]

    const first = await ask(id)
    expect(first.status).toBe(200)
    await first.text()
    expect(await tokensCharged()).toBe(15)

    const second = await ask(id)
    expect(second.status).toBe(429)
    expect(await second.json()).toEqual({
      error: HUSH_ALLOWANCE_MESSAGE,
      code: "allowance",
    })
    expect(calls).toBe(1)
  })

  it("stops a run between steps once the allowance runs out", async () => {
    // Two steps' worth is 30; the second step crosses 20, so the third is
    // never asked for.
    process.env[ENV] = "20"
    const id = await seed()
    script = [
      { tool: "get_document_overview" },
      { tool: "get_document_overview" },
      { text: "Never said." },
    ]

    const response = await ask(id)
    expect(response.status).toBe(200)
    const stream = await response.text()

    expect(calls).toBe(2)
    expect(stream).not.toContain("Never said.")
    // The panel is told why, in the sentence the refusal uses.
    expect(stream).toContain(
      JSON.stringify(HUSH_ALLOWANCE_MESSAGE).slice(1, -1)
    )
    expect(await tokensCharged()).toBe(30)
  })

  it("does not count anything against another visitor", async () => {
    process.env[ENV] = "10"
    const id = await seed()
    script = [{ text: "One." }]
    await (await ask(id)).text()

    const other = identity
    identity = { ...other, quotaKey: `${other.quotaKey}_other` }
    identities.push(identity)
    script = [{ text: "Two." }]
    calls = 0

    const response = await ask(id)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Two.")
  })
})
