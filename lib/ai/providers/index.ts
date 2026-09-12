import type { LanguageModel } from "ai"
import { modelId, ollamaUrl, providerId, type ProviderEnv } from "./config"

export type ProviderDefinition = {
  id: string
  label: string
  envKey?: string
  fields?: string[]
  modelsUrl?: string
  languageModel: (env: ProviderEnv, fetcher?: typeof fetch) => Promise<LanguageModel>
}

/** Only explicitly supported vendors appear here; a compatible protocol is not a provider. */
export const PROVIDERS: ProviderDefinition[] = [
  { id: "gateway", label: "Vercel AI Gateway", envKey: "AI_GATEWAY_API_KEY", modelsUrl: "https://ai-gateway.vercel.sh/v1/models",
    languageModel: async (env, fetch) => (await import("ai")).createGateway({ apiKey: env.AI_GATEWAY_API_KEY, fetch })(modelId(env)) },
  { id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY", modelsUrl: "https://api.openai.com/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/openai")).createOpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: "https://api.openai.com/v1", fetch })(modelId(env)) },
  { id: "anthropic", label: "Anthropic", envKey: "ANTHROPIC_API_KEY", modelsUrl: "https://api.anthropic.com/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/anthropic")).createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: "https://api.anthropic.com/v1", fetch })(modelId(env)) },
  { id: "google", label: "Google AI", envKey: "GOOGLE_GENERATIVE_AI_API_KEY", modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/google")).createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY, fetch })(modelId(env)) },
  { id: "xai", label: "xAI", envKey: "XAI_API_KEY", modelsUrl: "https://api.x.ai/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/xai")).createXai({ apiKey: env.XAI_API_KEY, fetch })(modelId(env)) },
  { id: "mistral", label: "Mistral", envKey: "MISTRAL_API_KEY", modelsUrl: "https://api.mistral.ai/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/mistral")).createMistral({ apiKey: env.MISTRAL_API_KEY, fetch })(modelId(env)) },
  { id: "togetherai", label: "Together.ai", envKey: "TOGETHER_API_KEY", modelsUrl: "https://api.together.xyz/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/togetherai")).createTogetherAI({ apiKey: env.TOGETHER_API_KEY, fetch })(modelId(env)) },
  { id: "cohere", label: "Cohere", envKey: "COHERE_API_KEY", modelsUrl: "https://api.cohere.com/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/cohere")).createCohere({ apiKey: env.COHERE_API_KEY, fetch })(modelId(env)) },
  { id: "fireworks", label: "Fireworks", envKey: "FIREWORKS_API_KEY", modelsUrl: "https://api.fireworks.ai/inference/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/fireworks")).createFireworks({ apiKey: env.FIREWORKS_API_KEY, fetch })(modelId(env)) },
  { id: "deepinfra", label: "DeepInfra", envKey: "DEEPINFRA_API_KEY", modelsUrl: "https://api.deepinfra.com/models/list",
    languageModel: async (env, fetch) => (await import("@ai-sdk/deepinfra")).createDeepInfra({ apiKey: env.DEEPINFRA_API_KEY, fetch })(modelId(env)) },
  { id: "deepseek", label: "DeepSeek", envKey: "DEEPSEEK_API_KEY", modelsUrl: "https://api.deepseek.com/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/deepseek")).createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY, fetch })(modelId(env)) },
  { id: "cerebras", label: "Cerebras", envKey: "CEREBRAS_API_KEY", modelsUrl: "https://api.cerebras.ai/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/cerebras")).createCerebras({ apiKey: env.CEREBRAS_API_KEY, fetch })(modelId(env)) },
  { id: "groq", label: "Groq", envKey: "GROQ_API_KEY", modelsUrl: "https://api.groq.com/openai/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/groq")).createGroq({ apiKey: env.GROQ_API_KEY, fetch })(modelId(env)) },
  { id: "perplexity", label: "Perplexity", envKey: "PERPLEXITY_API_KEY",
    languageModel: async (env, fetch) => (await import("@ai-sdk/perplexity")).createPerplexity({ apiKey: env.PERPLEXITY_API_KEY, fetch })(modelId(env)) },
  { id: "baseten", label: "Baseten", envKey: "BASETEN_API_KEY", modelsUrl: "https://inference.baseten.co/v1/models",
    languageModel: async (env, fetch) => (await import("@ai-sdk/baseten")).createBaseten({ apiKey: env.BASETEN_API_KEY, fetch })(modelId(env)) },
  { id: "azure", label: "Azure OpenAI", envKey: "AZURE_API_KEY", fields: ["AZURE_RESOURCE_NAME", "AZURE_SUBSCRIPTION_ID", "AZURE_RESOURCE_GROUP"],
    languageModel: async (env, fetch) => (await import("@ai-sdk/azure")).createAzure({ apiKey: env.AZURE_API_KEY, resourceName: env.AZURE_RESOURCE_NAME, fetch })(modelId(env)) },
  { id: "amazon-bedrock", label: "Amazon Bedrock", fields: ["AWS_REGION", "AWS_PROFILE"],
    languageModel: async (env, fetch) => {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock")
      const { bedrockClient } = await import("./cloud")
      const client = bedrockClient(env)
      return createAmazonBedrock({ region: env.AWS_REGION, apiKey: env.AWS_BEARER_TOKEN_BEDROCK,
        credentialProvider: () => client.config.credentials(), fetch })(modelId(env))
    } },
  { id: "google-vertex", label: "Google Vertex AI (Gemini)", fields: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
    languageModel: async (env, fetch) => (await import("@ai-sdk/google-vertex")).createGoogleVertex({
      project: env.GOOGLE_VERTEX_PROJECT, location: env.GOOGLE_VERTEX_LOCATION,
      apiKey: env.GOOGLE_VERTEX_API_KEY,
      googleAuthOptions: { keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS || undefined }, fetch })(modelId(env)) },
  { id: "ollama", label: "Ollama (local, no account)", fields: ["OLLAMA_BASE_URL"],
    languageModel: async (env, fetch) => (await import("@ai-sdk/openai-compatible")).createOpenAICompatible({
      name: "ollama", baseURL: `${ollamaUrl(env)}/v1`, supportsStructuredOutputs: true, fetch })(modelId(env)) },
]

export function selectedProvider(env: ProviderEnv = process.env): ProviderDefinition {
  const provider = PROVIDERS.find((entry) => entry.id === providerId(env))
  if (!provider) throw new Error("Unsupported AI_PROVIDER; choose a provider with pnpm setup")
  return provider
}

export function providerConfigured(env: ProviderEnv = process.env): boolean {
  const provider = PROVIDERS.find((entry) => entry.id === providerId(env))
  // Invalid explicit configuration must reach the contained failure path.
  if (!provider) return true
  if (provider.id === "gateway") return Boolean(env.AI_GATEWAY_API_KEY?.trim() || env.VERCEL_OIDC_TOKEN?.trim())
  if (provider.envKey) return Boolean(env[provider.envKey]?.trim())
  // IAM and local connectivity are resolved on use, with visible failures.
  return true
}

export async function languageModel(env: ProviderEnv = process.env, fetcher?: typeof fetch): Promise<LanguageModel> {
  if (!modelId(env)) throw new Error("AI_MODEL is required for the selected provider")
  return selectedProvider(env).languageModel(env, fetcher)
}
