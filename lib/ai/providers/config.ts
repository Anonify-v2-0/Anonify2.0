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
  return env.AI_MODEL?.trim() ||
    (providerId(env) === "gateway" ? DEFAULT_GATEWAY_MODEL : "")
}

/** Preserve old Gateway usage keys; qualify direct models to avoid price collisions. */
export function usageModelId(env: ProviderEnv = process.env): string {
  return providerId(env) === "gateway" ? modelId(env) : `${providerId(env)}:${modelId(env)}`
}

export function ollamaUrl(env: ProviderEnv = process.env): string {
  const url = new URL(env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_URL)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("OLLAMA_BASE_URL must be an HTTP(S) server URL without credentials or a query")
  }
  return url.toString().replace(/\/$/, "")
}

/** Bind verification to the destination as well as the model, so edits invalidate it. */
export function capabilityTarget(env: ProviderEnv): string {
  return JSON.stringify([
    providerId(env), modelId(env),
    providerId(env) === "ollama" ? ollamaUrl(env) : "",
    env.AZURE_RESOURCE_NAME || "", env.AWS_REGION || "",
    env.GOOGLE_VERTEX_PROJECT || "", env.GOOGLE_VERTEX_LOCATION || "",
  ])
}

export function capabilityDeclaration(env: ProviderEnv, capabilities: ModelCapabilities): string {
  return JSON.stringify({ target: capabilityTarget(env), ...capabilities })
}

export function configuredCapabilities(env: ProviderEnv = process.env): ModelCapabilities {
  if (!env.AI_MODEL_CAPABILITIES?.trim() && providerId(env) === "gateway") {
    // Existing installations keep their exact call behavior on upgrade.
    return { structuredOutput: true, vision: true }
  }
  try {
    const value = JSON.parse(env.AI_MODEL_CAPABILITIES || "")
    if (value.target === capabilityTarget(env) &&
        typeof value.structuredOutput === "boolean" && typeof value.vision === "boolean") {
      return { structuredOutput: value.structuredOutput, vision: value.vision }
    }
  } catch { /* Missing or stale verification must never imply support. */ }
  return { structuredOutput: false, vision: false }
}
