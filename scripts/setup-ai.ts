import {
  cacheable,
  formatAge,
  freshness,
  isFresh,
  loadCatalog,
  readCatalog,
  type CatalogResult,
} from "@/lib/ai/catalog"
import { PROVIDERS, selectedProvider } from "@/lib/ai/providers"
import {
  capabilityDeclaration,
  capabilityTarget,
  configuredCapabilities,
  DEFAULT_OLLAMA_URL,
  modelId,
  providerId,
  usageModelId,
  type ModelCapabilities,
  type ProviderEnv,
} from "@/lib/ai/providers/config"
import {
  blockedReason,
  DiscoveryError,
  ollamaAvailable,
  type ListPrice,
  type ModelDefinition,
} from "@/lib/ai/providers/discovery"
import { probeModel } from "@/lib/ai/providers/probe"
import { ratesFor } from "@/lib/ai/rates"
import {
  note,
  ok,
  Prompter,
  say,
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

/** Dollars to the precision a per-million rate is actually published at. */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0"
  const shown = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
  return shown === "0.00" ? "<$0.0001" : `$${shown}`
}

export function formatPrice(price: {
  inputPerMillion: number
  outputPerMillion: number
}): string {
  return `${formatUsd(price.inputPerMillion)} in · ${formatUsd(price.outputPerMillion)} out per 1M tokens`
}

/**
 * How prices apply to a model list: read from it (and how fresh), zero
 * because the model runs locally, or not carried by the list at all.
 */
export type PriceState = "fresh" | "stale" | "local" | undefined

/**
 * What a model row says about the model, and where each claim came from. The
 * provider's catalog is *advertised*; only setup's own probe is *verified*, and
 * the two must never read alike — a catalog that says "vision" has not been
 * shown an image. A list price is labelled as one, and as stale once it is.
 */
export function modelDetails(
  model: ModelDefinition,
  {
    verified,
    prices,
  }: { verified?: ModelCapabilities; prices?: PriceState } = {}
): string[] {
  const price = model.price
    ? `List price: ${formatPrice(model.price)}${model.price.tiered ? " · first tier; long prompts cost more" : ""}${model.price.variesByProvider ? " · varies by upstream provider" : ""}${prices === "stale" ? " · stale" : ""}`
    : prices === "local"
      ? "Price: none, runs locally"
      : prices
        ? "Price: not listed for this model"
        : undefined
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
    ...(price ? [price] : []),
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

/**
 * The provider's models, from the saved catalog when it is fresh. A stale one
 * is offered for refresh rather than silently refetched or silently used, and
 * a failed refresh falls back to it with its age said out loud.
 */
async function readModels(
  prompt: Prompter,
  env: ProviderEnv
): Promise<CatalogResult | undefined> {
  const provider = selectedProvider(env)
  const cached = cacheable(env) ? await readCatalog(env) : undefined
  let refresh: "auto" | "force" | "never" = "auto"
  if (cached && !isFresh(cached))
    refresh = (await prompt.confirm(
      `The saved ${provider.label} model list is from ${formatAge(cached.fetchedAt)}. Refresh it now?`,
      true
    ))
      ? "force"
      : "never"
  const live = !cached || refresh === "force"
  const listing = spin(
    live
      ? "Discovering models from the selected provider"
      : "Reading the saved model list"
  )
  try {
    const result = await loadCatalog(env, { refresh })
    if (result.origin === "stale") {
      listing.stop()
      warn(result.error ?? "The model list could not be refreshed.")
      warn(
        `Showing the list saved ${formatAge(result.catalog!.fetchedAt)}; models and prices may have changed.`
      )
    } else if (result.origin === "cache") {
      listing.succeed(
        `Found ${result.models.length} models in the list saved ${formatAge(result.catalog!.fetchedAt)}`
      )
      note("pnpm models:warm refreshes it.")
    } else {
      listing.succeed(`Found ${result.models.length} models`)
    }
    return result
  } catch (error) {
    listing.stop()
    warn(
      error instanceof DiscoveryError
        ? error.message
        : "Model discovery failed. Check this provider's configuration."
    )
  }
}

/**
 * Offers the chosen model's list price for the spend estimate.
 *
 * Never automatic: a price read from a catalog becomes a spend limit only
 * when somebody says yes to it, with its source and age in front of them. The
 * default is yes only for a fresh, flat price with nothing already configured
 * — replacing a price the operator set, or adopting a tiered, representative
 * or stale one, defaults to no.
 */
async function adoptPrice(
  prompt: Prompter,
  env: ProviderEnv,
  price: ListPrice,
  source: { label: string; fetchedAt: string; stale: boolean }
): Promise<void> {
  const key = usageModelId(env)
  let table: Record<string, unknown> = {}
  if (env.AI_MODEL_PRICES?.trim()) {
    try {
      const parsed: unknown = JSON.parse(env.AI_MODEL_PRICES)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object")
      table = parsed as Record<string, unknown>
    } catch {
      warn("AI_MODEL_PRICES is not a JSON object, so setup leaves it as it is.")
      return
    }
  }
  const configured = ratesFor(env)
  const offered = {
    inputPerMillion: price.inputPerMillion,
    outputPerMillion: price.outputPerMillion,
  }
  if (
    configured?.inputPerMillion === offered.inputPerMillion &&
    configured.outputPerMillion === offered.outputPerMillion
  ) {
    note("The spend estimate already uses this model's list price.")
    return
  }

  say()
  note(`List price for ${key}: ${formatPrice(offered)}`)
  note(
    `From ${source.label}, fetched ${formatAge(source.fetchedAt)}${source.stale ? " (stale)" : ""}.`
  )
  if (price.tiered)
    note("Tiered: this is the first tier's rate, and long prompts cost more.")
  if (price.variesByProvider)
    note("Representative: the upstream provider actually used may charge more.")
  if (configured) note(`Configured now: ${formatPrice(configured)}`)
  const accept = await prompt.confirm(
    configured
      ? "Replace the configured price with the list price?"
      : "Use it for this model's spend estimate? It is saved in AI_MODEL_PRICES, where you can change it.",
    !configured && !price.tiered && !price.variesByProvider && !source.stale
  )
  if (!accept) return
  env.AI_MODEL_PRICES = JSON.stringify({ ...table, [key]: offered })
  ok(`Saved the list price for ${key} to AI_MODEL_PRICES.`)
}

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
  const listed = await readModels(prompt, env)
  const models: ModelDefinition[] = listed?.models ?? []
  const catalog = listed?.catalog
  const prices: PriceState =
    picked === "ollama"
      ? "local"
      : catalog?.sources.prices
        ? freshness(catalog).prices
        : undefined
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
  if (models.length > 0 && prices === "fresh")
    note(
      `List prices from ${provider.label}'s model list, fetched ${formatAge(catalog!.fetchedAt)}. For reference: spend limits use only what is saved in .env.`
    )
  else if (models.length > 0 && prices === "stale")
    note(
      `List prices from ${provider.label}'s model list are from ${formatAge(catalog!.fetchedAt)} and may have changed. Spend limits use only what is saved in .env.`
    )
  else if (models.length > 0 && prices !== "local")
    note(
      `${provider.label}'s model list carries no prices, so none are shown. Spend estimates use AI_MODEL_PRICES in .env.`
    )
  // Kept across verification retries, so a failed model sends you back to the
  // page and search you chose it from rather than to the top of the catalog.
  const view: PagedView = { search: "" }
  for (;;) {
    const choices: Choice<string | symbol>[] = models.map((model) => ({
      value: model.id as string | symbol,
      label: model.id === currentId ? `${model.label} (current)` : model.label,
      detail: modelDetails(model, {
        verified: model.id === currentId ? verified : undefined,
        prices,
      }),
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
    if (known?.price && catalog)
      await adoptPrice(prompt, env, known.price, {
        label: `${provider.label}'s model list`,
        fetchedAt: catalog.fetchedAt,
        stale: prices === "stale",
      })
    return env
  }
}
