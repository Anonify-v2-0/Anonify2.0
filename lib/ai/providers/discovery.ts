import { selectedProvider } from "./index"
import { ollamaUrl, type ProviderEnv } from "./config"

export type ModelDefinition = {
  id: string
  label: string
  textOutput?: boolean
  structuredOutput?: boolean
  vision?: boolean
  unavailable?: string
}

export function blockedReason(
  model: ModelDefinition,
  requireVision: boolean
): string | undefined {
  if (model.unavailable) return model.unavailable
  if (model.textOutput === false) return "Does not generate text"
  if (model.structuredOutput === false)
    return "Does not support structured output"
  if (requireVision && model.vision === false)
    return "Does not accept images (choose text-only analysis to use it)"
}

/** Never expose provider response bodies: they can contain keys or request data. */
export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DiscoveryError"
  }
}

export async function readModelJson(
  url: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch
): Promise<unknown> {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      throw new DiscoveryError(
        `Model discovery failed (HTTP ${response.status}). Check credentials and model-list permissions.`
      )
    return await response.json()
  } catch (error) {
    if (error instanceof DiscoveryError) throw error
    throw new DiscoveryError(
      "Model discovery could not reach the provider or read its model list."
    )
  }
}

type Bag = Record<string, unknown>
function bag(value: unknown): Bag {
  return value && typeof value === "object" ? (value as Bag) : {}
}
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined
}

export function parseModel(
  provider: string,
  raw: unknown
): ModelDefinition | undefined {
  const row = bag(raw)
  const rawId = row.id ?? row.model_name ?? row.name ?? row.model
  if (
    typeof rawId !== "string" ||
    !rawId.trim() ||
    /[\x00-\x1f\x7f]/.test(rawId)
  )
    return
  const id =
    provider === "google" || provider === "google-vertex"
      ? rawId.replace(/^.*models\//, "")
      : rawId
  const caps = bag(row.capabilities)
  const architecture = bag(row.architecture)
  const input =
    strings(architecture.input_modalities) ??
    strings(row.input_modalities) ??
    strings(row.inputModalities)
  const output =
    strings(architecture.output_modalities) ??
    strings(row.output_modalities) ??
    strings(row.outputModalities)
  const methods = strings(row.supportedGenerationMethods)
  const endpoints = strings(row.endpoints)
  const model: ModelDefinition = { id, label: id }
  if (input)
    model.vision = input.some((value) => value.toLowerCase() === "image")
  if (output)
    model.textOutput = output.some((value) => value.toLowerCase() === "text")
  if (typeof caps.vision === "boolean") model.vision = caps.vision
  if (typeof row.supportsImageInput === "boolean")
    model.vision = row.supportsImageInput
  if (typeof caps.completion_chat === "boolean")
    model.textOutput = caps.completion_chat
  if (typeof caps.structured_outputs === "boolean")
    model.structuredOutput = caps.structured_outputs
  if (methods) model.textOutput = methods.includes("generateContent")
  if (endpoints) model.textOutput = endpoints.includes("chat")
  if (typeof row.type === "string") {
    const textTypes = [
      "language",
      "chat",
      "text",
      "text-generation",
      "text-to-text",
    ]
    const nonTextTypes = [
      "embedding",
      "image",
      "audio",
      "video",
      "rerank",
      "text-to-image",
      "text-to-speech",
      "automatic-speech-recognition",
      "text-classification",
    ]
    if (textTypes.includes(row.type)) model.textOutput = true
    if (nonTextTypes.includes(row.type)) model.textOutput = false
  }
  if (row.active === false || row.is_deprecated === true)
    model.unavailable = "Inactive or deprecated model"
  return model
}

export async function discoverModels(
  env: ProviderEnv,
  fetcher: typeof fetch = fetch
): Promise<ModelDefinition[]> {
  const provider = selectedProvider(env)
  if (["azure", "amazon-bedrock", "google-vertex"].includes(provider.id)) {
    return (await import("./cloud")).discoverCloudModels(env, fetcher)
  }
  if (provider.id === "ollama") {
    const result = bag(
      await readModelJson(`${ollamaUrl(env)}/api/tags`, {}, fetcher)
    )
    if (!Array.isArray(result.models))
      throw new DiscoveryError("Ollama did not return an installed-model list.")
    const models: ModelDefinition[] = []
    // Local /show is cheap metadata, but keep it serial to avoid flooding a small server.
    for (const raw of result.models) {
      const model = parseModel("ollama", raw)
      if (!model) continue
      try {
        const info = bag(
          await readModelJson(
            `${ollamaUrl(env)}/api/show`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: model.id }),
            },
            fetcher
          )
        )
        const capabilities = strings(info.capabilities)
        if (capabilities) {
          model.textOutput = capabilities.includes("completion")
          model.vision = capabilities.includes("vision")
        }
        if (
          info.remote_model ||
          info.remote_host ||
          model.id.endsWith(":cloud") ||
          model.id.endsWith("-cloud")
        ) {
          model.unavailable =
            "Ollama cloud models are outside local provider support"
        }
      } catch {
        model.unavailable = "Could not read this installed model's capabilities"
      }
      models.push(model)
    }
    return models.sort((a, b) => a.id.localeCompare(b.id))
  }
  if (!provider.modelsUrl)
    throw new DiscoveryError(
      "This provider has no model-list API for its SDK transport. Enter a model ID to verify it."
    )
  const headers: Record<string, string> = {}
  const key = provider.envKey ? env[provider.envKey] : undefined
  if (provider.id === "anthropic") {
    headers["x-api-key"] = key || ""
    headers["anthropic-version"] = "2023-06-01"
  } else if (provider.id === "google") headers["x-goog-api-key"] = key || ""
  else if (key) headers.Authorization = `Bearer ${key}`

  const models = new Map<string, ModelDefinition>()
  const modelsUrl =
    provider.id === "fireworks" && env.FIREWORKS_ACCOUNT_ID
      ? `https://api.fireworks.ai/v1/accounts/${encodeURIComponent(env.FIREWORKS_ACCOUNT_ID)}/models`
      : provider.modelsUrl
  let next: string | undefined = modelsUrl
  const visited = new Set<string>()
  while (next) {
    if (visited.has(next) || visited.size >= 100)
      throw new DiscoveryError(
        "The provider's model pagination did not finish."
      )
    visited.add(next)
    const raw = await readModelJson(next, { headers }, fetcher)
    const result = bag(raw)
    const rows = Array.isArray(raw) ? raw : (result.data ?? result.models)
    if (!Array.isArray(rows))
      throw new DiscoveryError(
        "The provider did not return a supported model list."
      )
    for (const row of rows) {
      const model = parseModel(provider.id, row)
      if (model) models.set(model.id, model)
    }
    const url = new URL(modelsUrl)
    const token = result.nextPageToken ?? result.next_page_token
    if (typeof token === "string" && token) {
      url.searchParams.set(
        provider.id === "cohere" ? "page_token" : "pageToken",
        token
      )
      next = url.toString()
    } else if (result.has_more === true && typeof result.last_id === "string") {
      url.searchParams.set("after_id", result.last_id)
      next = url.toString()
    } else next = undefined
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function ollamaAvailable(
  env: ProviderEnv,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  try {
    const result = bag(
      await readModelJson(
        `${ollamaUrl(env)}/api/tags`,
        { signal: AbortSignal.timeout(1000) },
        fetcher
      )
    )
    return Array.isArray(result.models)
  } catch {
    return false
  }
}
