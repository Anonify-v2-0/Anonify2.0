import { PROVIDERS, selectedProvider } from "@/lib/ai/providers"
import {
  capabilityDeclaration,
  capabilityTarget,
  configuredCapabilities,
  DEFAULT_OLLAMA_URL,
  modelId,
  providerId,
  type ProviderEnv,
} from "@/lib/ai/providers/config"
import {
  blockedReason,
  discoverModels,
  DiscoveryError,
  ollamaAvailable,
  type ModelDefinition,
} from "@/lib/ai/providers/discovery"
import { probeModel } from "@/lib/ai/providers/probe"
import { note, ok, Prompter, spin, warn } from "./tty"

export const AI_ENV_KEYS = [
  ...new Set([
    "AI_PROVIDER",
    "AI_MODEL",
    "AI_MODEL_CAPABILITIES",
    "AI_MODEL_PRICES",
    ...PROVIDERS.flatMap((provider) => [
      ...(provider.envKey ? [provider.envKey] : []),
      ...(provider.fields ?? []),
    ]),
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GOOGLE_VERTEX_API_KEY",
  ]),
]

export async function askAiProvider(
  prompt: Prompter,
  current: ProviderEnv,
  local: boolean
): Promise<ProviderEnv> {
  const env = { ...current }
  // Scripted setup must remain offline and preserve the operator's choices.
  if (!prompt.interactive)
    return Object.fromEntries(AI_ENV_KEYS.map((key) => [key, env[key] || ""]))
  const existing = Boolean(
    env.AI_PROVIDER ||
    env.AI_GATEWAY_API_KEY ||
    env.VERCEL_OIDC_TOKEN ||
    env.AI_MODEL
  )
  const defaultId =
    !existing && local && (await ollamaAvailable(env))
      ? "ollama"
      : providerId(env)
  const picked = await prompt.choose(
    "Which AI provider?",
    PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label })),
    Math.max(
      0,
      PROVIDERS.findIndex((entry) => entry.id === defaultId)
    )
  )
  const changed = picked !== providerId(env)
  env.AI_PROVIDER = picked
  if (changed) {
    env.AI_MODEL = ""
    env.AI_MODEL_CAPABILITIES = ""
  }
  const provider = selectedProvider(env)
  if (provider.envKey)
    env[provider.envKey] = await prompt.secret(
      provider.envKey,
      env[provider.envKey]
    )
  for (const field of provider.fields ?? []) {
    env[field] = await prompt.ask(field, {
      fallback:
        env[field] ||
        (field === "OLLAMA_BASE_URL"
          ? DEFAULT_OLLAMA_URL
          : field === "FIREWORKS_ACCOUNT_ID"
            ? "fireworks"
            : ""),
    })
  }
  if (picked === "amazon-bedrock")
    note(
      "Bedrock uses your AWS credential chain (profile, environment or role). Runtime bearer keys cannot list control-plane models."
    )
  if (picked === "azure")
    note(
      "Deployment discovery uses Azure CLI / managed identity credentials. Inference uses AZURE_API_KEY."
    )
  if (picked === "google-vertex")
    note(
      "Vertex uses Google Application Default Credentials. Credential files must also be available to the running app."
    )
  if (
    provider.envKey &&
    !env[provider.envKey] &&
    !(picked === "gateway" && env.VERCEL_OIDC_TOKEN)
  ) {
    warn(
      "No credential configured. AI detection stays off until the credential is set."
    )
    return env
  }
  if (
    existing &&
    !changed &&
    modelId(current) &&
    configuredCapabilities(current).structuredOutput &&
    capabilityTarget(current) === capabilityTarget(env) &&
    (await prompt.confirm(
      "Keep the current model and capability verification?",
      true
    ))
  )
    return env

  const requireVision = await prompt.choose("What should the model analyze?", [
    {
      value: true,
      label: "Text and images",
      detail: ["Requires structured output and image input."],
    },
    {
      value: false,
      label: "Text only",
      detail: [
        "Image-region analysis will be skipped and reported to the reviewer; OCR still runs.",
      ],
    },
  ])
  let models: ModelDefinition[] = []
  const listing = spin("Discovering models from the selected provider")
  try {
    models = await discoverModels(env)
    listing.succeed(`Found ${models.length} models`)
  } catch (error) {
    listing.stop()
    warn(
      error instanceof DiscoveryError
        ? error.message
        : "Model discovery failed. Check this provider's configuration."
    )
  }
  const manual = Symbol("manual")
  const cancel = Symbol("cancel")
  for (;;) {
    const choices = models.map((model) => ({
      value: model.id as string | symbol,
      label: model.label,
      detail: [
        model.vision === true
          ? "Image input advertised; verify before saving."
          : model.vision === false
            ? "Text only; verify before saving."
            : "Capabilities not advertised; verify before saving.",
      ],
      disabled: blockedReason(model, requireVision),
    }))
    const chosen = await prompt.choose("Which model?", [
      ...choices,
      { value: manual, label: "Enter a model / deployment ID and verify it" },
      {
        value: cancel,
        label: "Keep the current configuration and finish setup",
      },
    ])
    if (chosen === cancel) return current
    const id =
      chosen === manual
        ? await prompt.ask("Model / deployment ID", { fallback: modelId(env) })
        : String(chosen)
    if (!id || /[\x00-\x1f\x7f]/.test(id)) {
      warn("Enter a non-empty model ID without control characters.")
      continue
    }
    const known = models.find((model) => model.id === id)
    const blocked = known && blockedReason(known, requireVision)
    if (blocked) {
      warn(blocked)
      continue
    }
    // Typed Ollama IDs must also be installed and inspected; this closes the
    // manual-entry escape hatch for cloud and embedding-only models.
    if (picked === "ollama" && !known) {
      warn(
        "Choose an installed Ollama model from the discovered list. Pull it in Ollama, then rerun setup."
      )
      continue
    }
    if (
      !(await prompt.confirm(
        "Verify with two small synthetic requests? Hosted providers may charge for them.",
        true
      ))
    )
      continue
    const candidate = { ...env, AI_MODEL: id }
    const checking = spin(
      "Verifying structured output and image input (up to two minutes per request)"
    )
    const result = await probeModel(candidate)
    checking.stop()
    if (!result.structuredOutput || (requireVision && !result.vision)) {
      const reason = !result.structuredOutput
        ? "Structured-output verification failed; check model support, credentials, access and connectivity"
        : "Image verification failed; choose a vision model or rerun setup for text-only analysis"
      warn(reason)
      if (known) known.unavailable = reason
      else models.push({ id, label: id, unavailable: reason })
      continue
    }
    env.AI_MODEL = id
    env.AI_MODEL_CAPABILITIES = capabilityDeclaration(candidate, result)
    ok(
      result.vision
        ? "Structured output and image input verified."
        : "Structured output verified. Image analysis will be visibly skipped."
    )
    return env
  }
}
