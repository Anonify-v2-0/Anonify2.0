import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"

import type { ModelMessage, ToolApprovalResponse } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { saveNormalized } from "@/lib/documents/normalized-store"
import { extractText } from "@/lib/documents/text/extract"
import type { RuleTarget } from "@/lib/redaction/rules"
import { newDocumentSeal } from "@/lib/storage/sealed"

/**
 * Hush's human in the loop, run for real against a scripted model.
 *
 * The model is the only thing replaced. The agent loop, the tools, the
 * approval policy and the HMAC-signed approvals are the SDK's and ours, so
 * what is tested is what ships: a read waits for consent until it is given, a
 * change waits for approval every time, an approved change runs, a declined
 * one does not, and an approval the server did not issue is refused.
 */

type Step = {
  toolCalls?: { toolName: string; input: unknown }[]
  text?: string
}

let script: Step[] = []
let calls = 0

function modelFrom(steps: () => Step[]) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps()[calls] ?? { text: "Done." }
      calls += 1
      const content = step.toolCalls
        ? step.toolCalls.map((call, index) => ({
            type: "tool-call" as const,
            toolCallId: `call_${calls}_${index}`,
            toolName: call.toolName,
            input: JSON.stringify(call.input),
          }))
        : [{ type: "text" as const, text: step.text ?? "" }]
      return {
        content,
        finishReason: step.toolCalls
          ? { unified: "tool-calls" as const, raw: "tool_calls" }
          : { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 10,
            noCache: 10,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      }
    },
  })
}

vi.mock("@/lib/ai/providers", () => ({
  languageModel: async () => modelFrom(() => script),
}))

// The rule write path, stubbed at the database: what matters here is whether
// it ran, not Postgres, which the integration suite covers.
const transaction = vi.fn(async (writes: unknown[]) => writes)
vi.mock("@/lib/database/prisma", () => ({
  prisma: {
    $transaction: (writes: unknown[]) => transaction(writes),
    globalRule: { create: (input: unknown) => ({ create: input }) },
    redaction: {
      createMany: (input: unknown) => ({ createMany: input }),
      findMany: async () => [],
    },
  },
}))

const { buildHushAgent } = await import("@/lib/assistant/agent")

const ROOT = path.join(process.cwd(), ".anonify-storage", "documents")
const created: string[] = []

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64")
  process.env.FINGERPRINT_SECRET ??= randomBytes(32).toString("hex")
})

afterEach(() => {
  script = []
  calls = 0
  transaction.mockClear()
})

afterAll(async () => {
  await Promise.all(
    created.map((id) =>
      rm(path.join(ROOT, id), { recursive: true, force: true })
    )
  )
})

async function target(text: string): Promise<RuleTarget> {
  const id = `doc_agent_${randomBytes(6).toString("hex")}`
  created.push(id)
  const seal = newDocumentSeal()
  const model = extractText(
    id,
    new Uint8Array(Buffer.from(text, "utf8"))
  ).document
  const saved = await saveNormalized(id, seal, model)
  return {
    id,
    encryptionKey: seal.wrappedKey,
    encryptionFormat: seal.format,
    normalizedBlobKey: saved.key,
    normalizedIndex: saved.index,
  }
}

async function agentFor(readConsent: boolean) {
  const document = await target("Staff EMP-00123 and EMP-00456.")
  return buildHushAgent({
    context: {
      documentId: document.id,
      target: document,
      batchId: null,
      ownerKey: "owner",
      name: "notes.txt",
      kind: "txt",
    },
    view: { currentPage: 1 },
    readConsent,
  })
}

type Approval = {
  type: string
  approvalId: string
  toolCall: { toolName: string }
  isAutomatic?: boolean
}

function approvalsIn(content: { type: string }[]): Approval[] {
  return content.filter(
    (part) => part.type === "tool-approval-request"
  ) as unknown as Approval[]
}

/** The first tool result among the messages a run returned. */
function toolResultIn<T>(messages: ModelMessage[]): T | undefined {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content as {
      type: string
      output?: { value: unknown }
    }[]) {
      if (part.type === "tool-result") return part.output?.value as T
    }
  }
  return undefined
}

function reply(
  messages: ModelMessage[],
  responses: ToolApprovalResponse[]
): ModelMessage[] {
  return [...messages, { role: "tool", content: responses }]
}

describe("reading the document", () => {
  it("asks once before its first read, and does not read until allowed", async () => {
    script = [{ toolCalls: [{ toolName: "read_page", input: { page: 1 } }] }]
    const agent = await agentFor(false)

    const result = await agent.generate({ prompt: "What is on page 1?" })
    const [approval] = approvalsIn(result.content)

    expect(approval.toolCall.toolName).toBe("read_page")
    expect(result.content.some((part) => part.type === "tool-result")).toBe(
      false
    )
  })

  it("carries on with the read the reviewer allowed, in the request that allows it", async () => {
    script = [
      { toolCalls: [{ toolName: "read_page", input: { page: 1 } }] },
      { text: "Two IDs." },
    ]
    const document = await target("Staff EMP-00123 and EMP-00456.")
    const build = (readConsent: boolean) =>
      buildHushAgent({
        context: {
          documentId: document.id,
          target: document,
          batchId: null,
          ownerKey: "owner",
          name: "notes.txt",
          kind: "txt",
        },
        view: {},
        readConsent,
      })

    const first = await (
      await build(false)
    ).generate({ prompt: "What is on page 1?" })
    const [approval] = approvalsIn(first.content)

    // The panel's next request says reading is now allowed, and replays the
    // signed approval for the read that asked.
    const messages = reply(
      [
        { role: "user", content: "What is on page 1?" },
        ...first.responseMessages,
      ],
      [
        {
          type: "tool-approval-response",
          approvalId: approval.approvalId,
          approved: true,
        },
      ]
    )
    const second = await (await build(true)).generate({ messages })

    const read = toolResultIn<{ text: string }>(second.responseMessages)
    expect(read?.text).toContain("EMP-00456")
    expect(second.text).toBe("Two IDs.")
  })

  it("reads without asking once the reviewer has allowed it", async () => {
    script = [
      { toolCalls: [{ toolName: "read_page", input: { page: 1 } }] },
      { text: "Two IDs." },
    ]
    const agent = await agentFor(true)

    const result = await agent.generate({ prompt: "What is on page 1?" })

    expect(approvalsIn(result.content)).toEqual([])
    const read = result.steps[0].toolResults[0]
    expect((read.output as { text: string }).text).toContain("EMP-00123")
    expect(result.text).toBe("Two IDs.")
  })
})

describe("changing the review", () => {
  const createRule = {
    toolName: "create_rule",
    input: {
      kind: "regex",
      pattern: "EMP-\\d{5}",
      matchCase: true,
      wholeWord: true,
      category: "customer-id",
      scope: "document",
      reason: "Employee numbers recur.",
    },
  }

  it("waits for approval even with reading allowed, then runs once approved", async () => {
    script = [{ toolCalls: [createRule] }, { text: "Created." }]
    const agent = await agentFor(true)

    const first = await agent.generate({ prompt: "Redact employee numbers" })
    const [approval] = approvalsIn(first.content)
    expect(approval.toolCall.toolName).toBe("create_rule")
    expect(transaction).not.toHaveBeenCalled()

    const messages = reply(
      [
        { role: "user", content: "Redact employee numbers" },
        ...first.responseMessages,
      ],
      [
        {
          type: "tool-approval-response",
          approvalId: approval.approvalId,
          approved: true,
        },
      ]
    )
    const second = await agent.generate({ messages })

    expect(transaction).toHaveBeenCalledOnce()
    // An approved call runs before the next model step, so its result is in
    // the messages the run returns rather than in a step of its own.
    expect(toolResultIn(second.responseMessages)).toMatchObject({
      created: true,
      redactions: 2,
    })
    expect(second.text).toBe("Created.")
  })

  it("does nothing when the reviewer declines", async () => {
    script = [{ toolCalls: [createRule] }, { text: "Understood." }]
    const agent = await agentFor(true)

    const first = await agent.generate({ prompt: "Redact employee numbers" })
    const [approval] = approvalsIn(first.content)
    const messages = reply(
      [
        { role: "user", content: "Redact employee numbers" },
        ...first.responseMessages,
      ],
      [
        {
          type: "tool-approval-response",
          approvalId: approval.approvalId,
          approved: false,
        },
      ]
    )
    await agent.generate({ messages })

    expect(transaction).not.toHaveBeenCalled()
  })

  it("refuses an approval this server never issued", async () => {
    script = [{ toolCalls: [createRule] }, { text: "Created." }]
    const agent = await agentFor(true)

    const first = await agent.generate({ prompt: "Redact employee numbers" })
    const [approval] = approvalsIn(first.content)

    // A client that edits the pending call's input after the approval was
    // signed — widening the pattern, say — no longer matches the signature.
    const tampered = first.responseMessages.map((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? {
            ...message,
            content: message.content.map((part) =>
              part.type === "tool-call"
                ? {
                    ...part,
                    input: { ...(part.input as object), pattern: "\\w+" },
                  }
                : part
            ),
          }
        : message
    ) as ModelMessage[]

    const messages = reply(
      [{ role: "user", content: "Redact employee numbers" }, ...tampered],
      [
        {
          type: "tool-approval-response",
          approvalId: approval.approvalId,
          approved: true,
        },
      ]
    )

    await expect(agent.generate({ messages })).rejects.toThrow()
    expect(transaction).not.toHaveBeenCalled()
  })
})
