import { PROVIDERS } from "./providers"
import {
  isLocalProvider,
  usageModelId,
  type ProviderEnv,
} from "./providers/config"
import { estimateCost, type ModelRates } from "./usage-types"

/** Prices belong to a provider/model pair, including historical rows after switching. */
export function configuredRates(model = usageModelId()): ModelRates | null {
  return ratesFor(process.env, model)
}

/**
 * The same rules against any environment — setup checks the `.env` it has
 * just written with exactly what the app will enforce.
 */
export function ratesFor(
  env: ProviderEnv,
  model = usageModelId(env)
): ModelRates | null {
  // Usage rows are `provider:model`, so a historical row keeps its own
  // provider's answer after the instance switches away from it. A local
  // server costs nothing per token. Neither does a flat subscription, unless
  // the operator records a price for it (to see what the usage would cost, or
  // to let the spend cap limit it): leaving it unpriced would otherwise make
  // the whole spend cap unenforceable.
  const provider = model.slice(0, Math.max(0, model.indexOf(":")))
  if (isLocalProvider(provider))
    return { inputPerMillion: 0, outputPerMillion: 0 }
  if (PROVIDERS.find((entry) => entry.id === provider)?.login) {
    return (
      recordedRates(env, model) ?? { inputPerMillion: 0, outputPerMillion: 0 }
    )
  }
  if (env.AI_MODEL_PRICES?.trim()) {
    // An explicit table is authoritative; missing entries do not inherit another model's price.
    return recordedRates(env, model)
  }
  if (model !== usageModelId(env)) return null
  const input = env.AI_PRICE_INPUT_PER_MTOK?.trim()
  const output = env.AI_PRICE_OUTPUT_PER_MTOK?.trim()
  if (!input || !output) return null
  const rates = {
    inputPerMillion: Number(input),
    outputPerMillion: Number(output),
  }
  return Object.values(rates).every(
    (value) => Number.isFinite(value) && value >= 0
  )
    ? rates
    : null
}

export function estimateRows(
  rows: { model: string; inputTokens: number; outputTokens: number }[]
): number | null {
  if (rows.length === 0) return configuredRates() ? 0 : null
  let total = 0
  for (const row of rows) {
    const cost = estimateCost(row, configuredRates(row.model))
    if (cost === null) return null
    total += cost
  }
  return total
}

/** This model's entry in AI_MODEL_PRICES, if the table has a valid one. */
function recordedRates(env: ProviderEnv, model: string): ModelRates | null {
  try {
    const entry = JSON.parse(env.AI_MODEL_PRICES || "{}")[model]
    if (
      entry &&
      typeof entry.inputPerMillion === "number" &&
      typeof entry.outputPerMillion === "number" &&
      Number.isFinite(entry.inputPerMillion) &&
      Number.isFinite(entry.outputPerMillion) &&
      entry.inputPerMillion >= 0 &&
      entry.outputPerMillion >= 0
    )
      return entry
  } catch {
    /* A malformed table prices nothing. */
  }
  return null
}
