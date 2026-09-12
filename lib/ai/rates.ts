import { usageModelId } from "./providers/config"
import { estimateCost, type ModelRates } from "./usage-types"

/** Prices belong to a provider/model pair, including historical rows after switching. */
export function configuredRates(model = usageModelId()): ModelRates | null {
  if (model.startsWith("ollama:"))
    return { inputPerMillion: 0, outputPerMillion: 0 }
  if (process.env.AI_MODEL_PRICES?.trim()) {
    try {
      const entry = JSON.parse(process.env.AI_MODEL_PRICES)[model]
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
      // An explicit table is authoritative; missing entries do not inherit another model's price.
      return null
    } catch {
      return null
    }
  }
  if (model !== usageModelId()) return null
  const input = process.env.AI_PRICE_INPUT_PER_MTOK?.trim()
  const output = process.env.AI_PRICE_OUTPUT_PER_MTOK?.trim()
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
