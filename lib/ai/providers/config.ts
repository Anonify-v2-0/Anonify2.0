import { compatibleProfile, takesBaseUrl } from "./compatible"

export type ProviderEnv = Record<string, string | undefined>

export const DEFAULT_GATEWAY_MODEL = "anthropic/claude-haiku-4.5"
export const DEFAULT_OLLAMA_URL = "http://localhost:11434"

export type ModelCapabilities = {
  structuredOutput: boolean
  vision: boolean
}

export function providerId(env: ProviderEnv = process.env): string {
  return env.AI_PROVIDER?.trim() || "gateway"
}

export function modelId(env: ProviderEnv = process.env): string {
  return (
    env.AI_MODEL?.trim() ||
    (providerId(env) === "gateway" ? DEFAULT_GATEWAY_MODEL : "")
  )
}

/** Preserve old Gateway usage keys; qualify direct models to avoid price collisions. */
export function usageModelId(env: ProviderEnv = process.env): string {
  return providerId(env) === "gateway"
    ? modelId(env)
    : `${providerId(env)}:${modelId(env)}`
}

/**
 * A server the operator named by URL, checked and normalized.
 *
 * No credentials, query or fragment: a key belongs in its own variable, where
 * setup conceals it, and not in a URL that ends up in a capability
 * declaration, a cache file and a bug report. `toHost` is for a container,
 * where a loopback address means the host rather than the container itself.
 */
function serverUrl(raw: string, name: string, toHost: boolean): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL`)
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be an HTTP(S) server URL without credentials or a query`
    )
  }
  if (toHost && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal"
  }
  return url.toString().replace(/\/$/, "")
}

export function ollamaUrl(
  env: ProviderEnv = process.env,
  connect = true
): string {
  return serverUrl(
    env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_URL,
    "OLLAMA_BASE_URL",
    connect && env.ANONIFY_CONTAINER === "1"
  )
}

/** The chat-completions base URL of the selected OpenAI-compatible profile. */
export function compatibleBaseUrl(
  env: ProviderEnv = process.env,
  connect = true
): string {
  const profile = compatibleProfile(providerId(env))
  if (!profile)
    throw new Error("The selected AI provider is not an OpenAI-compatible one")
  const raw = takesBaseUrl(profile)
    ? env.AI_BASE_URL?.trim() || profile.baseUrl
    : profile.baseUrl
  if (!raw)
    throw new Error(`AI_BASE_URL is required for AI_PROVIDER=${profile.id}`)
  return serverUrl(raw, "AI_BASE_URL", connect && env.ANONIFY_CONTAINER === "1")
}

/**
 * Runs on the operator's machine: no provider spend, one request at a time,
 * and a model list read live because it is whatever is installed right now.
 */
export function isLocalProvider(id: string = providerId()): boolean {
  return id === "ollama" || Boolean(compatibleProfile(id)?.local)
}

/** Bind verification to the destination as well as the model, so edits invalidate it. */
export function capabilityTarget(env: ProviderEnv): string {
  const target: unknown[] = [
    providerId(env),
    modelId(env),
    providerId(env) === "ollama" ? ollamaUrl(env, false) : "",
    env.AZURE_RESOURCE_NAME || "",
    env.AWS_REGION || "",
    env.GOOGLE_VERTEX_PROJECT || "",
    env.GOOGLE_VERTEX_LOCATION || "",
    Boolean(env.GOOGLE_VERTEX_API_KEY),
  ]
  // Appended rather than inserted: every declaration already written for the
  // providers above has to keep matching, or an upgrade would quietly turn
  // their contextual pass into "unsupported".
  if (compatibleProfile(providerId(env))) {
    try {
      target.push(compatibleBaseUrl(env, false))
    } catch {
      target.push("invalid")
    }
  }
  return JSON.stringify(target)
}

export function capabilityDeclaration(
  env: ProviderEnv,
  capabilities: ModelCapabilities
): string {
  return JSON.stringify({ target: capabilityTarget(env), ...capabilities })
}

export function configuredCapabilities(
  env: ProviderEnv = process.env
): ModelCapabilities {
  if (!env.AI_MODEL_CAPABILITIES?.trim() && providerId(env) === "gateway") {
    // Existing installations keep their exact call behavior on upgrade.
    return { structuredOutput: true, vision: true }
  }
  try {
    const value = JSON.parse(env.AI_MODEL_CAPABILITIES || "")
    if (
      value.target === capabilityTarget(env) &&
      typeof value.structuredOutput === "boolean" &&
      typeof value.vision === "boolean"
    ) {
      return { structuredOutput: value.structuredOutput, vision: value.vision }
    }
  } catch {
    /* Missing or stale verification must never imply support. */
  }
  return { structuredOutput: false, vision: false }
}
