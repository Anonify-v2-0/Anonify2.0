import { PROVIDERS, selectedProvider } from "@/lib/ai/providers"
import {
  capabilityDeclaration,
  capabilityTarget,
  configuredCapabilities,
  DEFAULT_OLLAMA_URL,
  modelId,
  providerId,
  type ModelCapabilities,
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
import {
  note,
  ok,
  Prompter,
  spin,
  warn,
  type Choice,
  type PagedView,
} from "./tty"

function yesNo(value: boolean | undefined): string {
  return value === true ? "yes" : value === false ? "no" : "unknown"
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`
  return String(count)
}

/**
 * What a model row says about the model, and where each claim came from. The
 * provider's catalog is *advertised*; only setup's own probe is *verified*, and
 * the two must never read alike — a catalog that says "vision" has not been
 * shown an image.
 */
export function modelDetails(
  model: ModelDefinition,
  verified?: ModelCapabilities
): string[] {
  const advertised = [
    ["text", model.textOutput],
    ["images", model.vision],
    ["structured output", model.structuredOutput],
  ] as const
  const context = model.contextWindow
    ? `${formatTokens(model.contextWindow)} context`
    : "context unknown"
  return [
    ...(model.name ? [model.name] : []),
    advertised.every(([, value]) => value === undefined)
      ? `Advertised: no capabilities listed · ${context}`
      : `Advertised: ${advertised.map(([what, value]) => `${what} ${yesNo(value)}`).join(" · ")} · ${context}`,
    ...(verified
      ? [
          `Verified by setup: structured output ${yesNo(verified.structuredOutput)} · images ${yesNo(verified.vision)}`,
        ]
      : []),
  ]
}

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
  if (picked === "amazon-bedrock") {
    const auth = await prompt.choose(
      "Bedrock authentication",
      [
        {
          value: "chain",
          label: "Use AWS environment credentials, profile or role",
        },
        { value: "keys", label: "Enter AWS access credentials" },
        { value: "bearer", label: "Enter a Bedrock runtime API key" },
      ],
      env.AWS_BEARER_TOKEN_BEDROCK ? 2 : 0
    )
    if (auth !== "bearer") env.AWS_BEARER_TOKEN_BEDROCK = ""
    if (auth === "keys") {
      for (const key of [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
      ])
        env[key] = await prompt.secret(key, env[key])
    }
    if (auth === "bearer")
      env.AWS_BEARER_TOKEN_BEDROCK = await prompt.secret(
        "AWS_BEARER_TOKEN_BEDROCK",
        env.AWS_BEARER_TOKEN_BEDROCK
      )
  }
  if (picked === "azure")
    note(
      "Deployment discovery uses Azure CLI / managed identity credentials. Inference uses AZURE_API_KEY."
    )
  if (picked === "google-vertex")
    note(
      "Vertex uses Google Application Default Credentials. Credential files must also be available to the running app."
    )
  if (picked === "google-vertex") {
    const auth = await prompt.choose(
      "Vertex authentication",
      [
        { value: "adc", label: "Use Google Application Default Credentials" },
        { value: "key", label: "Enter a Vertex express-mode API key" },
      ],
      env.GOOGLE_VERTEX_API_KEY ? 1 : 0
    )
    env.GOOGLE_VERTEX_API_KEY =
      auth === "key"
        ? await prompt.secret(
            "GOOGLE_VERTEX_API_KEY",
            env.GOOGLE_VERTEX_API_KEY
          )
        : ""
  }
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
      label: "Text (image support optional)",
      detail: [
        "If image verification fails, image-region analysis is skipped and reported; OCR still runs.",
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
  const currentId = changed ? "" : modelId(current)
  // Only a declaration setup wrote itself, for this exact target. The Gateway
  // upgrade fallback assumes support without checking, which is not verified.
  const verified =
    current.AI_MODEL_CAPABILITIES?.trim() &&
    configuredCapabilities(current).structuredOutput &&
    capabilityTarget(current) === capabilityTarget(env)
      ? configuredCapabilities(current)
      : undefined
  if (models.length > 0)
    note(
      "Prices are not shown: model lists do not carry them reliably. Spend limits use the AI_PRICE_* values in .env."
    )
  // Kept across verification retries, so a failed model sends you back to the
  // page and search you chose it from rather than to the top of the catalog.
  const view: PagedView = { search: "" }
  for (;;) {
    const choices: Choice<string | symbol>[] = models.map((model) => ({
      value: model.id as string | symbol,
      label: model.id === currentId ? `${model.label} (current)` : model.label,
      detail: modelDetails(
        model,
        model.id === currentId ? verified : undefined
      ),
      disabled: blockedReason(model, requireVision),
    }))
    const chosen = await prompt.choosePaged("Which model?", choices, {
      noun: "models",
      pageSize: 8,
      searchHint: "Search by model ID or name",
      searchText: (choice) => {
        const model = models.find((entry) => entry.id === choice.value)
        return `${model?.id ?? ""} ${model?.name ?? ""}`
      },
      initial: currentId || undefined,
      view,
      actions: [
        { value: manual, label: "Enter a model / deployment ID and verify it" },
        {
          value: cancel,
          label: "Keep the current configuration and finish setup",
        },
      ],
    })
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
