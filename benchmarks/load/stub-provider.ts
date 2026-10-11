/**
 * A model provider that costs nothing and answers the same way every time
 * (#190).
 *
 * An OpenAI-compatible server, so the instance under test points at it with
 * the provider it would use for any other endpoint:
 *
 *   AI_PROVIDER=openai-compatible
 *   AI_BASE_URL=http://<this machine>:4010/v1
 *   AI_MODEL=anonify-load-stub
 *   AI_MODEL_CAPABILITIES=<printed by `pnpm load stub`>
 *
 * A load test measures Anonify, not a vendor. A real provider's latency moves
 * with the time of day, its rate limits are the account's rather than the
 * deployment's, and every run spends money. This one waits a configurable
 * time, refuses a configurable share of calls with 429, and otherwise returns
 * the smallest object the request's JSON schema allows: no detections, the
 * first value of every enum. Nothing in a request is logged or kept, only
 * counted.
 */

import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"

export const STUB_MODEL = "anonify-load-stub"

export type StubOptions = {
  port: number
  /** Median time to answer, in milliseconds. */
  latencyMs: number
  /** Share of calls refused with 429, 0–1. */
  rateLimitShare: number
  /** Seed for the jitter and the 429s, so two runs see the same sequence. */
  seed: number
}

export type StubCounters = {
  calls: number
  refused: number
  inputTokens: number
  outputTokens: number
}

type JsonSchema = {
  type?: string | string[]
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minItems?: number
  minLength?: number
  minimum?: number
  exclusiveMinimum?: number
  default?: unknown
  $ref?: string
  $defs?: Record<string, JsonSchema>
  definitions?: Record<string, JsonSchema>
}

/**
 * The smallest value a JSON schema accepts: what a model that found nothing
 * would return. Every call the pipeline makes has a schema whose empty answer
 * is valid ("no detections", "no columns"), and an empty answer exercises the
 * whole path — the call, its accounting, the merge — without inventing
 * findings that would change what the reviewer then accepts.
 */
export function minimalInstance(
  schema: JsonSchema,
  root: JsonSchema = schema,
  depth = 0
): unknown {
  if (depth > 32) return null
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop() ?? ""
    const target = root.$defs?.[name] ?? root.definitions?.[name]
    return target ? minimalInstance(target, root, depth + 1) : null
  }
  if (schema.const !== undefined) return schema.const
  if (schema.enum?.length) return schema.enum[0]
  const alternative = schema.anyOf?.[0] ?? schema.oneOf?.[0]
  if (alternative) return minimalInstance(alternative, root, depth + 1)
  if (schema.allOf?.length) {
    return Object.assign(
      {},
      ...schema.allOf.map((part) => minimalInstance(part, root, depth + 1))
    )
  }
  const type = Array.isArray(schema.type)
    ? (schema.type.find((name) => name !== "null") ?? "null")
    : schema.type
  switch (type) {
    case "object": {
      const value: Record<string, unknown> = {}
      for (const key of schema.required ?? []) {
        const property = schema.properties?.[key]
        value[key] = property
          ? minimalInstance(property, root, depth + 1)
          : null
      }
      return value
    }
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () =>
        schema.items ? minimalInstance(schema.items, root, depth + 1) : null
      )
    case "string":
      return "x".repeat(schema.minLength ?? 0)
    case "number":
    case "integer":
      return schema.minimum ?? (schema.exclusiveMinimum ?? -1) + 1
    case "boolean":
      return false
    case "null":
      return null
    default:
      return schema.default ?? null
  }
}

/** mulberry32: small, seeded, and good enough to spread latencies. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

type ChatRequest = {
  stream?: boolean
  response_format?: {
    type?: string
    json_schema?: { schema?: JsonSchema }
  }
}

/** Starts the stub. Resolves once it is listening. */
export async function startStubProvider(options: StubOptions): Promise<{
  server: Server
  url: string
  counters: StubCounters
  close: () => Promise<void>
}> {
  const counters: StubCounters = {
    calls: 0,
    refused: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
  const next = random(options.seed)

  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown, headers = {}) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      })
      response.end(JSON.stringify(body))
    }
    const url = new URL(request.url ?? "/", "http://stub")

    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      send(200, {
        object: "list",
        data: [{ id: STUB_MODEL, object: "model", owned_by: "anonify-load" }],
      })
      return
    }
    if (
      request.method !== "POST" ||
      !url.pathname.endsWith("/chat/completions")
    ) {
      send(404, { error: { message: "not found" } })
      return
    }

    const raw = await readBody(request)
    counters.calls += 1

    // Uniform between half and one and a half times the median: wide enough
    // that calls finish out of order, as they do against a real provider.
    const delay = options.latencyMs * (0.5 + next())
    const refuse = next() < options.rateLimitShare
    await new Promise((resolve) => setTimeout(resolve, delay))

    if (refuse) {
      counters.refused += 1
      send(
        429,
        { error: { message: "rate limited (stub)", type: "rate_limit" } },
        { "retry-after": "1" }
      )
      return
    }

    let body: ChatRequest = {}
    try {
      body = JSON.parse(raw) as ChatRequest
    } catch {
      send(400, { error: { message: "invalid JSON" } })
      return
    }
    const schema = body.response_format?.json_schema?.schema
    const content = JSON.stringify(schema ? minimalInstance(schema) : {})
    // Roughly what a tokenizer would count, so spend reports are not all zero.
    const inputTokens = Math.ceil(raw.length / 4)
    const outputTokens = Math.ceil(content.length / 4)
    counters.inputTokens += inputTokens
    counters.outputTokens += outputTokens

    const id = `chatcmpl-stub-${counters.calls}`
    const created = Math.floor(Date.now() / 1000)
    const usage = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    }

    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      const chunk = (delta: object, finish: string | null, extra = {}) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: STUB_MODEL,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        })}\n\n`
      response.write(chunk({ role: "assistant", content }, null))
      response.write(chunk({}, "stop", { usage }))
      response.end("data: [DONE]\n\n")
      return
    }

    send(200, {
      id,
      object: "chat.completion",
      created,
      model: STUB_MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage,
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, "0.0.0.0", () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    server,
    url: `http://127.0.0.1:${port}/v1`,
    counters,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
