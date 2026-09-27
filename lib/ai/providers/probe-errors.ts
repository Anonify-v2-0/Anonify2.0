/**
 * Why a verification request failed, in words an operator can act on.
 *
 * The probe used to turn every failure into "structured-output verification
 * failed", which is true and useless: a revoked key, a mistyped base URL, a
 * model the account cannot use, a parameter the endpoint refuses, a server
 * that is not running and a model that answered in prose all read the same.
 *
 * This is for the probe only, and the probe sends synthetic input only, so
 * what a provider says back cannot quote a document. It can still quote a
 * credential ("Incorrect API key provided: sk-…"), so everything shown from a
 * provider is redacted first: the configured credential values themselves,
 * then anything shaped like a key, a bearer token or a JWT. The analysis path
 * does not use this; it still logs a category and nothing else (invariant 6).
 */

import {
  APICallError,
  JSONParseError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  NoSuchModelError,
  RetryError,
  TypeValidationError,
} from "ai"

import type { ProviderEnv } from "./config"

export type ProbeFailureReason =
  | "authorization"
  | "not-found"
  | "rejected"
  | "rate-limit"
  | "budget"
  | "provider"
  | "unreachable"
  | "timeout"
  | "invalid-output"
  | "wrong-answer"
  | "configuration"
  | "unknown"

export type ProbeFailure = {
  reason: ProbeFailureReason
  /** One or two sentences, safe to print: redacted and truncated. */
  detail: string
}

const MAX_QUOTE = 300

/** Environment names whose values are credentials, for exact-value redaction. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)$/

/**
 * `text` with every credential it might carry replaced, control characters
 * removed and its length bounded. Exported for the tests, which are the
 * reason to trust it.
 */
export function redact(text: string, env: ProviderEnv = {}): string {
  let out = text
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) || !value || value.trim().length < 8) continue
    out = out.split(value.trim()).join("[redacted]")
  }
  out = out
    .replace(/Bearer\s+[^\s"',]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g, "[redacted]")
    .replace(/\b(sk|rk|pk|gsk|xai|sess)[-_][\w-]{8,}/gi, "[redacted]")
    .replace(/\bAIza[\w-]{20,}/g, "[redacted]")
    .replace(/\b[\w-]{40,}\b/g, "[redacted]")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return out.length > MAX_QUOTE ? `${out.slice(0, MAX_QUOTE - 1)}…` : out
}

/** What the provider said, from the shapes providers use for an error body. */
export function providerMessage(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.trim()) return
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Not JSON. A short plain-text body is a message; an HTML page is not.
    return /^\s*</.test(body) ? undefined : body
  }
  const bag = (value: unknown) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const root = bag(parsed)
  const error = bag(root.error)
  for (const candidate of [
    error.message,
    typeof root.error === "string" ? root.error : undefined,
    root.detail,
    bag(root.detail).message,
    root.message,
    error.code,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate
  }
  if (Array.isArray(root.detail) && root.detail.length > 0)
    return JSON.stringify(root.detail)
}

function said(message: string | undefined, env: ProviderEnv): string {
  return message ? ` The provider said: "${redact(message, env)}"` : ""
}

function statusDetail(
  status: number,
  message: string | undefined,
  env: ProviderEnv
): ProbeFailure {
  const quote = said(message, env)
  if (status === 401 || status === 403)
    return {
      reason: "authorization",
      detail: `The provider rejected the credentials (HTTP ${status}). Check the key, or sign in again.${quote}`,
    }
  if (status === 404)
    return {
      reason: "not-found",
      detail: `Not found (HTTP 404): the model ID is not one this account can use, or the base URL is wrong.${quote}`,
    }
  if (status === 402)
    return {
      reason: "budget",
      detail: `The account is out of credit (HTTP 402).${quote}`,
    }
  if (status === 429)
    return {
      reason: "rate-limit",
      detail: `Rate-limited or over quota (HTTP 429). Wait and try again, or check the plan's limits.${quote}`,
    }
  if (status >= 500)
    return {
      reason: "provider",
      detail: `The provider failed (HTTP ${status}). Try again shortly.${quote}`,
    }
  return {
    reason: "rejected",
    detail: `The provider refused the request (HTTP ${status}). This usually means the model does not support structured (JSON-schema) output or image input, or the endpoint does not accept a parameter.${quote}`,
  }
}

/** Node's network error codes, from wherever fetch buried them. */
function networkCode(error: unknown): string | undefined {
  let current: unknown = error
  for (
    let depth = 0;
    depth < 8 && current && typeof current === "object";
    depth++
  ) {
    const { code, cause } = current as { code?: unknown; cause?: unknown }
    if (
      typeof code === "string" &&
      /^(E[A-Z_]+|UND_ERR_[A-Z_]+|CERT_|ERR_TLS|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO)/.test(
        code
      )
    )
      return code
    current = cause
  }
}

function isTimeout(error: unknown): boolean {
  let current: unknown = error
  for (
    let depth = 0;
    depth < 8 && current && typeof current === "object";
    depth++
  ) {
    const name = (current as { name?: unknown }).name
    if (name === "TimeoutError" || name === "AbortError") return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Describes a failed verification request. `stage` names which of the two
 * requests it was, since "the image request failed" and "the text request
 * failed" point at different fixes.
 */
export function describeProbeError(
  error: unknown,
  env: ProviderEnv,
  stage: "structured" | "image"
): ProbeFailure {
  // The SDK wraps the error that ended its retries; describe that one.
  if (RetryError.isInstance(error) && error.lastError)
    return describeProbeError(error.lastError, env, stage)

  if (APICallError.isInstance(error)) {
    if (error.statusCode !== undefined)
      return statusDetail(
        error.statusCode,
        providerMessage(error.responseBody) ?? error.message,
        env
      )
    // No status: the request never got an answer.
    const failure = describeProbeError(error.cause, env, stage)
    if (failure.reason !== "unknown") return failure
    return {
      reason: "unreachable",
      detail: `Could not connect to the provider: ${redact(error.message, env)}. Check the base URL, and that the server is running and reachable from here.`,
    }
  }

  if (NoObjectGeneratedError.isInstance(error)) {
    const cause = error.cause
    const answer = error.text?.trim()
    return {
      reason: "invalid-output",
      detail:
        (TypeValidationError.isInstance(cause)
          ? "The model answered with JSON that does not match the requested schema."
          : JSONParseError.isInstance(cause)
            ? "The model answered, but not with JSON."
            : "The model answered, but not with the requested structured output.") +
        " It may not support structured output; a larger or instruction-tuned model usually does." +
        (answer
          ? ` Its answer began: "${redact(answer, env).slice(0, 160)}"`
          : ""),
    }
  }
  if (NoOutputGeneratedError.isInstance(error))
    return {
      reason: "invalid-output",
      detail:
        "The model returned nothing. It may have stopped early, or spent its whole answer on reasoning.",
    }
  if (NoSuchModelError.isInstance(error))
    return {
      reason: "not-found",
      detail: "The provider has no such model. Check the model ID.",
    }
  if (LoadAPIKeyError.isInstance(error))
    return {
      reason: "configuration",
      detail: "No API key is configured for this provider.",
    }

  // Our own errors: a missing sign-in, a malformed base URL. Their messages
  // are written to be printed.
  if (error instanceof Error && error.name === "SubscriptionAuthError")
    return { reason: "authorization", detail: redact(error.message, env) }
  if (
    error instanceof Error &&
    /^(AI_BASE_URL|OLLAMA_BASE_URL|AI_MODEL) /.test(error.message)
  )
    return { reason: "configuration", detail: error.message }

  const code = networkCode(error)
  if (code === "ECONNREFUSED")
    return {
      reason: "unreachable",
      detail:
        "Connection refused: nothing is listening at the provider's address. Is the server running, and is the base URL right?",
    }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return {
      reason: "unreachable",
      detail:
        "The provider's host name does not resolve. Check the base URL and this machine's network.",
    }
  if (code && /CERT|TLS|SELF_SIGNED|UNABLE_TO|DEPTH_ZERO/.test(code))
    return {
      reason: "unreachable",
      detail: `The provider's TLS certificate was not accepted (${code}).`,
    }
  if (
    isTimeout(error) ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  )
    return {
      reason: "timeout",
      detail:
        stage === "image"
          ? "No answer to the image request within two minutes. Local models on a CPU can be this slow reading an image."
          : "No answer within two minutes. The model may still be loading, or the server is overloaded.",
    }
  if (code)
    return {
      reason: "unreachable",
      detail: `The request did not reach the provider (${code}).`,
    }

  return {
    reason: "unknown",
    detail:
      error instanceof Error
        ? `Unexpected error: ${redact(`${error.name}: ${error.message}`, env)}`
        : "Unexpected error.",
  }
}
