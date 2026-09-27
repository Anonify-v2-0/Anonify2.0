/**
 * Choosing, verifying and pricing a model, then saying so in `.env`: the part
 * of `pnpm ai verify` that `pnpm ai login` also runs once it has signed in.
 *
 * Split out of `scripts/ai.ts`, which runs `main()` on import, so the whole
 * sequence — the provider's own model list, the probe, the price, the lines
 * written — can be tested against fixtures (tests/ai-login-flow.test.ts).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { PROVIDERS, selectedProvider } from "@/lib/ai/providers"
import {
  capabilityDeclaration,
  capabilityTarget,
  configuredCapabilities,
  modelId,
  providerId,
  type ProviderEnv,
} from "@/lib/ai/providers/config"
import { probeModel } from "@/lib/ai/providers/probe"

import { quoteEnvValue, updateEnv } from "./env-file"
import { askModelPrice, chooseModel, setModelPrice } from "./setup-ai"
import { fail, note, ok, say, spin, warn, type Prompter } from "./tty"

export type Price = { inputPerMillion: number; outputPerMillion: number }

/**
 * `env` with a different provider selected. The previous provider's model and
 * verification do not carry over; a model named here does.
 */
export function switchProvider(
  env: ProviderEnv,
  id: string,
  model?: string
): ProviderEnv {
  if (!PROVIDERS.some((entry) => entry.id === id))
    throw new Error(
      `Unknown provider "${id}". One of: ${PROVIDERS.map((entry) => entry.id).join(", ")}.`
    )
  const next = { ...env }
  if (id !== providerId(env)) {
    next.AI_PROVIDER = id
    next.AI_MODEL_CAPABILITIES = ""
    next.AI_MODEL = ""
  }
  if (model) next.AI_MODEL = model
  return next
}

/**
 * Verifies the model `env` names, or, with a terminal and none named, offers
 * the provider's own model list to choose from, exactly as setup does. Then
 * the price: one given on the command line is recorded; for a subscription,
 * which publishes none, a terminal is asked.
 *
 * Returns the settings to write, or null when nothing was verified, in which
 * case the reason has been printed and nothing should change.
 */
export async function configureModel(options: {
  env: ProviderEnv
  /** What is in force now: the picker marks its model as current. */
  before: ProviderEnv
  /** A terminal to ask in. Without one the model must already be named. */
  prompt?: Prompter
  textOnly?: boolean
  price?: Price
}): Promise<Record<string, string> | null> {
  let env = { ...options.env }
  const provider = selectedProvider(env)

  if (!modelId(env)) {
    if (!options.prompt)
      throw new Error("No model is configured. Name one with --model <id>.")
    const chosen = await chooseModel(options.prompt, env, options.before)
    // Backing out of the picker hands back what was in force before, and
    // that may still look configured (a Gateway default does). Only a model
    // verified just now, for the provider asked for, counts.
    if (
      chosen === options.before ||
      providerId(chosen) !== provider.id ||
      !modelId(chosen) ||
      !chosen.AI_MODEL_CAPABILITIES?.trim() ||
      !configuredCapabilities(chosen).structuredOutput
    ) {
      warn("Nothing verified, so nothing was changed.")
      return null
    }
    env = chosen
  } else {
    note(
      `Verifying ${modelId(env)} on ${provider.label} with two small synthetic requests. Hosted providers may bill them.`
    )
    const checking = spin(
      "Verifying structured output and image input (up to two minutes per request)"
    )
    const result = await probeModel(env)
    checking.stop()
    if (!result.structuredOutput) {
      fail(`Structured-output verification of ${modelId(env)} failed.`)
      if (result.detail) note(result.detail)
      return null
    }
    if (!result.vision && !options.textOnly) {
      fail(
        `Image verification of ${modelId(env)} failed. Choose a vision model, or pass --text-only to have image analysis skipped and reported.`
      )
      if (result.detail) note(result.detail)
      return null
    }
    if (!result.vision && result.detail) note(`Images: ${result.detail}`)
    env.AI_MODEL_CAPABILITIES = capabilityDeclaration(env, result)
    ok(
      result.vision
        ? "Structured output and image input verified."
        : "Structured output verified. Image analysis will be visibly skipped."
    )
  }

  if (options.price) {
    if (!setModelPrice(env, options.price)) return null
  } else if (options.prompt && provider.login) {
    await askModelPrice(options.prompt, env)
  }

  const updates: Record<string, string> = {
    AI_PROVIDER: providerId(env),
    AI_MODEL: modelId(env),
    AI_MODEL_CAPABILITIES: env.AI_MODEL_CAPABILITIES ?? "",
  }
  // A list price the picker adopted, or a price recorded above.
  if (
    env.AI_MODEL_PRICES &&
    env.AI_MODEL_PRICES !== options.before.AI_MODEL_PRICES
  )
    updates.AI_MODEL_PRICES = env.AI_MODEL_PRICES
  // Guards the declaration against a mismatch this command would write itself.
  if (
    JSON.parse(updates.AI_MODEL_CAPABILITIES).target !== capabilityTarget(env)
  )
    throw new Error("The verification does not match the configuration.")
  return updates
}

/**
 * Writes the settings into an existing `.env` in place, leaving every other
 * line as it was; or prints them, when asked to or when there is no `.env`.
 */
export function writeSettings(
  updates: Record<string, string>,
  options: { print?: boolean; file?: string } = {}
): void {
  const file = options.file ?? ".env"
  if (options.print || !existsSync(file)) {
    if (!options.print)
      note("No .env here; set these where the app reads its environment:")
    for (const [key, value] of Object.entries(updates))
      say(`${key}=${quoteEnvValue(value)}`)
    return
  }
  writeFileSync(file, updateEnv(readFileSync(file, "utf8"), updates))
  ok(
    `Wrote ${Object.keys(updates).join(", ")} to ${file === ".env" ? ".env" : file}. Restart the app to use it.`
  )
}
