import type { ModelEntry } from "./bench"
import type { Palette } from "../corpus/lib/tui"

/**
 * Makes sure the app will actually call this model.
 *
 * The app sends a model structured-output calls only once it has been
 * verified, and a verification (AI_MODEL_CAPABILITIES) is bound to one
 * provider and model. Every other model in BENCH_MODELS would be
 * "unsupported": each document analysed on the patterns alone, at no cost,
 * looking like a model that found nothing. The same goes for the one model
 * `corpus:score --detector pipeline` runs: neither command reads `.env`, so
 * neither has the instance's verification. So a model the declaration does
 * not cover is probed here, with `pnpm ai verify`'s two synthetic calls, and
 * the result applies to this run only; nothing is written.
 */
export async function ensureVerified(
  entry: ModelEntry,
  c: Palette,
  dryRun: boolean
): Promise<boolean> {
  const { capabilityDeclaration, configuredCapabilities } =
    await import("@/lib/ai/providers/config")
  // Only a declaration for this very model counts. With none, the app assumes
  // a Gateway model can answer in a schema, so an upgrade keeps working; a
  // benchmark is there to find out, and two models that could not once ran
  // 55 documents with every model pass cut short before anyone noticed.
  if (
    process.env.AI_MODEL_CAPABILITIES?.trim() &&
    configuredCapabilities().structuredOutput
  )
    return true
  if (dryRun) {
    console.log(
      c.dim(
        "  not verified yet: a real run verifies it first (two small calls)"
      )
    )
    return true
  }
  const { probeModel } = await import("@/lib/ai/providers/probe")
  const result = await probeModel(process.env)
  if (!result.structuredOutput) {
    console.log(
      c.red(
        `  ${entry.provider}:${entry.model} failed verification (${result.reason ?? result.failure}): ${result.detail ?? "no structured output"}`
      )
    )
    return false
  }
  process.env.AI_MODEL_CAPABILITIES = capabilityDeclaration(process.env, {
    structuredOutput: true,
    vision: result.vision,
  })
  console.log(
    c.dim("  verified for this run: structured output works (not saved)")
  )
  return true
}
