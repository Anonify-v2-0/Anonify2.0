import { createServer, type ServerResponse } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"

import { APICallError, RetryError } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  describeProbeError,
  providerMessage,
  redact,
} from "@/lib/ai/providers/probe-errors"
import { probeModel } from "@/lib/ai/providers/probe"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function apiError(
  statusCode: number | undefined,
  body: string,
  cause?: unknown
) {
  return new APICallError({
    message: "Bad Request",
    url: "https://provider.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody: body,
    cause,
  })
}

describe("redaction of what a provider says back", () => {
  it("removes the configured credentials and anything shaped like one", () => {
    const env = {
      OPENAI_API_KEY: "sk-proj-abcdefghijklmnop1234",
      AI_API_KEY: "plain-secret-value",
      AI_MODEL: "gpt-4o",
    }
    const text = redact(
      "Incorrect API key provided: sk-proj-abcdefghijklmnop1234. Also plain-secret-value, Bearer abc.def and eyJhbGciOi.eyJzdWIiOiIx.sig; model gpt-4o",
      env
    )
    expect(text).not.toContain("abcdefghijklmnop")
    expect(text).not.toContain("plain-secret-value")
    expect(text).not.toContain("abc.def")
    expect(text).not.toContain("eyJhbGciOi")
    // A model ID is not a secret, and naming it is the point.
    expect(text).toContain("gpt-4o")
  })

  it("flattens control characters and bounds the length", () => {
    const text = redact(`line one\n\u0007line two ${"word ".repeat(200)}`)
    expect(text).not.toMatch(/[\n\u0007]/)
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text.endsWith("…")).toBe(true)
  })

  it("reads the message from each shape providers use", () => {
    expect(providerMessage('{"error":{"message":"No such model"}}')).toBe(
      "No such model"
    )
    expect(providerMessage('{"detail":"Unsupported model"}')).toBe(
      "Unsupported model"
    )
    expect(providerMessage('{"error":"model not found"}')).toBe(
      "model not found"
    )
    expect(providerMessage('{"error":{"code":"usage_limit_reached"}}')).toBe(
      "usage_limit_reached"
    )
    expect(providerMessage("upstream timed out")).toBe("upstream timed out")
    expect(providerMessage("<html><body>502</body></html>")).toBeUndefined()
    expect(providerMessage("")).toBeUndefined()
  })
})

describe("what each failure is called", () => {
  const env = { OPENAI_API_KEY: "sk-live-0123456789abcdef" }

  it("names the HTTP failures, and quotes the provider without its secrets", () => {
    const rejected = describeProbeError(
      apiError(
        401,
        '{"error":{"message":"Incorrect API key provided: sk-live-0123456789abcdef"}}'
      ),
      env,
      "structured"
    )
    expect(rejected.reason).toBe("authorization")
    expect(rejected.detail).toContain("HTTP 401")
    expect(rejected.detail).toContain("Incorrect API key provided")
    expect(rejected.detail).not.toContain("0123456789abcdef")

    expect(
      describeProbeError(
        apiError(404, '{"error":{"message":"The model `x` does not exist"}}'),
        env,
        "structured"
      )
    ).toMatchObject({ reason: "not-found" })
    expect(
      describeProbeError(
        apiError(
          400,
          '{"error":{"message":"Invalid parameter: response_format of type json_schema is not supported with this model."}}'
        ),
        env,
        "structured"
      )
    ).toMatchObject({
      reason: "rejected",
      detail: expect.stringContaining("json_schema is not supported"),
    })
    expect(
      describeProbeError(apiError(429, ""), env, "structured").reason
    ).toBe("rate-limit")
    expect(
      describeProbeError(apiError(402, ""), env, "structured").reason
    ).toBe("budget")
    expect(
      describeProbeError(apiError(503, ""), env, "structured").reason
    ).toBe("provider")
  })

  it("looks through the SDK's retry wrapper to the error that ended it", () => {
    const wrapped = new RetryError({
      message: "Failed after 1 attempt",
      reason: "maxRetriesExceeded",
      errors: [apiError(401, "")],
    })
    expect(describeProbeError(wrapped, env, "structured").reason).toBe(
      "authorization"
    )
  })

  it("tells a server that is not running from one that does not resolve or answer", () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1234"), {
        code: "ECONNREFUSED",
      }),
    })
    expect(describeProbeError(refused, env, "structured")).toMatchObject({
      reason: "unreachable",
      detail: expect.stringContaining("nothing is listening"),
    })
    // The SDK wraps a network failure in an APICallError with no status.
    expect(
      describeProbeError(apiError(undefined, "", refused), env, "structured")
        .reason
    ).toBe("unreachable")

    const unresolved = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND nope"), {
        code: "ENOTFOUND",
      }),
    })
    expect(describeProbeError(unresolved, env, "structured").detail).toContain(
      "does not resolve"
    )

    const timeout = new DOMException("The operation timed out.", "TimeoutError")
    expect(describeProbeError(timeout, env, "image")).toMatchObject({
      reason: "timeout",
      detail: expect.stringContaining("image"),
    })
  })

  it("passes our own configuration and sign-in messages through", () => {
    expect(
      describeProbeError(
        new Error("AI_BASE_URL is required for AI_PROVIDER=openai-compatible"),
        env,
        "structured"
      )
    ).toMatchObject({ reason: "configuration" })
    const signIn = Object.assign(
      new Error("Not signed in. Run pnpm ai login --provider openai."),
      { name: "SubscriptionAuthError" }
    )
    expect(describeProbeError(signIn, env, "structured")).toEqual({
      reason: "authorization",
      detail: "Not signed in. Run pnpm ai login --provider openai.",
    })
  })
})

/** An OpenAI-compatible server that answers every chat request as told. */
async function server(
  answer: (body: Record<string, unknown>, response: ServerResponse) => void
) {
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    answer(JSON.parse(Buffer.concat(chunks).toString() || "{}"), response)
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  return {
    env: {
      AI_PROVIDER: "openai-compatible",
      AI_BASE_URL: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
      AI_API_KEY: "sk-fixture-secret-key-value",
      AI_MODEL: "fixture",
    },
    async close() {
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

function completion(response: ServerResponse, content: string) {
  response.setHeader("Content-Type", "application/json")
  response.end(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
  )
}

const hasImage = (body: Record<string, unknown>) =>
  JSON.stringify(body.messages).includes("image_url")

describe("the probe, against a real SDK call", () => {
  it("reports what the provider said when it refuses structured output", async () => {
    const fixture = await server((_, response) => {
      response.statusCode = 400
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify({
          error: {
            message:
              "response_format json_schema is not supported by this model (key sk-fixture-secret-key-value)",
          },
        })
      )
    })
    try {
      const result = await probeModel(fixture.env)
      expect(result).toMatchObject({
        structuredOutput: false,
        failure: "structured-output",
        reason: "rejected",
      })
      expect(result.detail).toContain("HTTP 400")
      expect(result.detail).toContain("json_schema is not supported")
      expect(result.detail).not.toContain("sk-fixture-secret-key-value")
    } finally {
      await fixture.close()
    }
  })

  it("shows the start of an answer that was not JSON", async () => {
    const fixture = await server((_, response) =>
      completion(response, "Sure! The answer is five.")
    )
    try {
      const result = await probeModel(fixture.env)
      expect(result.reason).toBe("invalid-output")
      expect(result.detail).toContain("not with JSON")
      expect(result.detail).toContain("Sure! The answer is five.")
    } finally {
      await fixture.close()
    }
  })

  it("says what a wrong answer was", async () => {
    const fixture = await server((_, response) =>
      completion(response, JSON.stringify({ answer: 7 }))
    )
    try {
      const result = await probeModel(fixture.env)
      expect(result).toMatchObject({ reason: "wrong-answer" })
      expect(result.detail).toContain("7")
    } finally {
      await fixture.close()
    }
  })

  it("says why the image request failed, separately from the text one", async () => {
    const fixture = await server((body, response) => {
      if (!hasImage(body))
        return completion(response, JSON.stringify({ answer: 5 }))
      response.statusCode = 400
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify({
          error: { message: "This model does not support image input." },
        })
      )
    })
    try {
      const result = await probeModel(fixture.env)
      expect(result).toMatchObject({
        structuredOutput: true,
        vision: false,
        failure: "vision",
        reason: "rejected",
      })
      expect(result.detail).toContain("does not support image input")
    } finally {
      await fixture.close()
    }
  })

  it("says nothing is listening when the server is down", async () => {
    // A port that was just free: open it, then close it again.
    const probe = createServer()
    probe.listen(0, "127.0.0.1")
    await once(probe, "listening")
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const result = await probeModel({
      AI_PROVIDER: "llama-cpp",
      AI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      AI_MODEL: "m",
    })
    expect(result.reason).toBe("unreachable")
    expect(result.detail).toContain("nothing is listening")
  })

  it("still calls a connection failure it cannot name a connection failure", () => {
    const failure = describeProbeError(
      apiError(undefined, "", new Error("bad port")),
      {},
      "structured"
    )
    expect(failure.reason).toBe("unreachable")
    expect(failure.detail).toContain("Could not connect")
  })
})
