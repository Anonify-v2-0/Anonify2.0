/**
 * Vendors and servers that speak only the OpenAI chat-completions protocol.
 *
 * A protocol is not a provider, but most "new providers" are a protocol plus a
 * base URL and the name of an environment variable. So these are data: each
 * row becomes a provider in ./index through the official
 * `@ai-sdk/openai-compatible` adapter, which Ollama already uses, and gets the
 * same model discovery (`GET {baseUrl}/models`), setup probe and visible
 * `unsupported` degradation as every other provider.
 *
 * Adding one is a row here, a line in `.env.example` and in the Compose
 * file's pass-through list, and a row in docs/ai-providers.md. Nothing else.
 *
 * Deliberately no imports: `./config` reads this table, and `./index` builds
 * providers from it.
 */
export type CompatibleProfile = {
  /** The `AI_PROVIDER` value, and the prefix of this provider's usage rows. */
  id: string
  label: string
  /**
   * Fixed for a hosted vendor. For a local server it is the default, and
   * `AI_BASE_URL` overrides it; with none at all, `AI_BASE_URL` is required.
   */
  baseUrl?: string
  /** Where the key is read from. Omitted for servers that take none. */
  envKey?: string
  /** A key the endpoint may or may not want, so a blank one is not an error. */
  keyOptional?: boolean
  /**
   * Runs on the operator's own machine: no provider spend, one request at a
   * time by default, and its model list read live rather than cached.
   */
  local?: boolean
}

export const COMPATIBLE_PROFILES: CompatibleProfile[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
  },
  {
    id: "synthetic",
    label: "Synthetic",
    baseUrl: "https://api.synthetic.new/openai/v1",
    envKey: "SYNTHETIC_API_KEY",
  },
  {
    id: "lm-studio",
    label: "LM Studio (local, no account)",
    baseUrl: "http://localhost:1234/v1",
    local: true,
  },
  {
    id: "llama-cpp",
    label: "llama.cpp server (local, no account)",
    baseUrl: "http://localhost:8080/v1",
    local: true,
  },
  {
    // Last, and the only one without a URL: whatever the operator points it at.
    // Never assumed local, since the URL may be anybody's; price it with
    // AI_MODEL_PRICES and pace it with ANONIFY_AI_* like any hosted provider.
    id: "openai-compatible",
    label: "Any other OpenAI-compatible endpoint (by URL)",
    envKey: "AI_API_KEY",
    keyOptional: true,
  },
]

export function compatibleProfile(id: string): CompatibleProfile | undefined {
  return COMPATIBLE_PROFILES.find((profile) => profile.id === id)
}

/** Whether the operator chooses this profile's URL, through `AI_BASE_URL`. */
export function takesBaseUrl(profile: CompatibleProfile): boolean {
  return !profile.baseUrl || Boolean(profile.local)
}
