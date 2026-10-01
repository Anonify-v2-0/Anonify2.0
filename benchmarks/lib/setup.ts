import { formatAge, freshness } from "@/lib/ai/catalog"
import { PROVIDERS, selectedProvider } from "@/lib/ai/providers"
import {
  isLocalProvider,
  usageModelId,
  type ProviderEnv,
} from "@/lib/ai/providers/config"
import {
  blockedReason,
  type ModelDefinition,
} from "@/lib/ai/providers/discovery"
import { signIn } from "@/scripts/ai-login"
import {
  AI_ENV_KEYS,
  askCredentials,
  formatPrice,
  hasCredential,
  modelDetails,
  readModels,
  type PriceState,
} from "@/scripts/setup-ai"
import {
  note,
  ok,
  paint,
  Prompter,
  say,
  warn,
  type Choice,
  type PagedView,
} from "@/scripts/tty"

import type { ModelEntry } from "./bench"
import { newEncryptionKey } from "./environment"

/**
 * The questions `pnpm bench:models` asks before it spends anything: which
 * corpus and how much of it, which phases, and which providers and models,
 * with a key or a sign-in for each provider.
 *
 * It reuses setup's own pieces (the provider list, the credential questions,
 * model discovery and its list prices) against the benchmark's environment,
 * never the instance's. Every answer it gathers comes back as `updates`, to
 * be saved to benchmarks/.bench/.env so the next run can offer it again.
 */

type Price = { inputPerMillion: number; outputPerMillion: number }

/** The settings that say which model; the benchmark sets them per model. */
const PER_MODEL = new Set([
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_MODEL_CAPABILITIES",
  "AI_MODEL_PRICES",
])

// --- the corpus ---------------------------------------------------------------

export type CorpusInfo = {
  name: string
  /** The committed archive the documents are unpacked from, relative. */
  archive: string | null
  hash: string | null
  counts: { test: number; dev: number }
}

export function corpusLines(corpus: CorpusInfo): string[] {
  const total = corpus.counts.test + corpus.counts.dev
  return [
    `${paint.bold(corpus.name)}  ${paint.gray(corpus.archive ?? "no archive; the working copy as it is")}`,
    `${total} documents: ${corpus.counts.test} test, ${corpus.counts.dev} dev  ${paint.gray(`manifest ${corpus.hash ? `${corpus.hash.slice(7, 19)}…` : "missing"}`)}`,
  ]
}

/**
 * Which split, and how many of its documents. A question already answered on
 * the command line is not asked again.
 */
export async function askCorpus(
  prompt: Prompter,
  corpus: CorpusInfo,
  given: { split?: string; askLimit: boolean }
): Promise<{ split: string; limit?: number }> {
  say()
  say(`  ${paint.bold("Corpus")}`)
  for (const line of corpusLines(corpus)) say(`    ${line}`)
  const all = corpus.counts.test + corpus.counts.dev
  const split =
    given.split ??
    (await prompt.choose("Which documents?", [
      {
        value: "test",
        label: `The test split (${corpus.counts.test})`,
        detail: ["What published results are measured on."],
      },
      {
        value: "dev",
        label: `The dev split (${corpus.counts.dev})`,
        detail: ["For trying prompts and settings; not for results."],
      },
      { value: "all", label: `Both (${all})` },
    ]))
  if (!given.askLimit) return { split }
  const available =
    split === "test"
      ? corpus.counts.test
      : split === "dev"
        ? corpus.counts.dev
        : all
  say()
  note(
    "Fewer documents is a cheaper, quicker look; the results file is still written, and says it is partial."
  )
  const wanted = await prompt.askInteger(
    `How many of the ${available} documents?`,
    { fallback: available }
  )
  return {
    split,
    limit: wanted < available ? wanted : undefined,
  }
}

export const PHASE_CHOICES: Choice<string>[] = [
  {
    value: "deterministic-first,model-only,throughput",
    label: "All three phases",
    detail: [
      "Deterministic-first, model-only, and a throughput sweep at rising concurrency.",
    ],
  },
  {
    value: "deterministic-first,model-only",
    label: "Deterministic-first and model-only",
    detail: ["Quality, and the tokens the patterns save. No sweep."],
  },
  {
    value: "deterministic-first",
    label: "Deterministic-first only",
    detail: ["The pipeline as it ships. The cheapest run."],
  },
]

// --- providers and models -------------------------------------------------------

/** AI_MODEL_PRICES as an object; a value that is not one starts over, empty. */
export function priceTable(raw: string | undefined): Record<string, Price> {
  try {
    const parsed: unknown = JSON.parse(raw?.trim() || "{}")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, Price>
  } catch {
    /* below */
  }
  return {}
}

function validPrice(price: unknown): price is Price {
  const p = price as Price | undefined
  return (
    typeof p?.inputPerMillion === "number" &&
    typeof p.outputPerMillion === "number" &&
    p.inputPerMillion >= 0 &&
    p.outputPerMillion >= 0
  )
}

/** The saved list, as entries: what the next run offers to reuse. */
export function modelList(entries: ModelEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.provider}:${e.model}${e.label !== e.model ? `=${e.label}` : ""}`
    )
    .join(", ")
}

/**
 * Makes sure the benchmark has its own ChatGPT sign-in, in its own store,
 * sealed under its own key. Never the instance's: that one lives in the
 * instance's database, and is refreshed (rotated) by the app as it is used.
 */
async function ensureSignedIn(
  prompt: Prompter,
  env: ProviderEnv,
  updates: Record<string, string>
): Promise<boolean> {
  if (!env.ENCRYPTION_KEY) {
    env.ENCRYPTION_KEY = updates.ENCRYPTION_KEY = newEncryptionKey()
    process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY
  }
  const subscription = await import("@/lib/ai/providers/subscription")
  const login = await subscription.loadLogin().catch((error: Error) => {
    warn(error.message)
    return null
  })
  if (login) {
    const profile = login.profile ?? subscription.profileOf(login.access)
    note(
      `Signed in to ChatGPT${profile?.email ? ` as ${profile.email}` : ""}${profile?.plan ? ` (${subscription.planName(profile.plan)})` : ""}, for the benchmark only.`
    )
    if (await prompt.confirm("Use this sign-in?", true)) return true
  }
  say()
  note(
    "Signing in uses the public client OpenAI ships with Codex CLI, against the backend Codex uses. OpenAI's terms decide whether a subscription may be used this way, and they can change."
  )
  note(
    "The sign-in is kept for the benchmark alone, sealed in benchmarks/.bench/store.json. The instance's own sign-in, if it has one, is not touched."
  )
  if (!(await prompt.confirm("Sign in with ChatGPT now?", true))) return false
  const token = await prompt.handOff(() =>
    signIn({ browser: true, interactive: prompt.interactive })
  )
  await subscription.saveLogin(token)
  ok("Signed in. Sealed in benchmarks/.bench/store.json.")
  if (!token.accountId)
    warn("The token names no ChatGPT workspace; calls may be refused.")
  return true
}

/**
 * Chooses any number of the provider's models: choosing one adds it, choosing
 * it again takes it out, and Done ends the list. The models setup would refuse
 * (no structured output, no text) are shown and cannot be chosen.
 */
async function pickModels(
  prompt: Prompter,
  env: ProviderEnv,
  already: string[]
): Promise<{
  ids: string[]
  models: ModelDefinition[]
  priced: { label: string; fetchedAt: string; stale: boolean } | null
}> {
  const provider = selectedProvider(env)
  const listed = await readModels(prompt, env)
  const models = listed?.models ?? []
  const catalog = listed?.catalog
  const prices: PriceState = isLocalProvider(provider.id)
    ? "local"
    : catalog?.sources.prices
      ? freshness(catalog).prices
      : undefined
  const chosen: string[] = []
  const view: PagedView = { search: "" }
  const done = Symbol("done")
  const manual = Symbol("manual")
  for (;;) {
    const choices: Choice<string | symbol>[] = models.map((model) => {
      const picked = chosen.includes(model.id)
      return {
        value: model.id,
        label: `${picked ? paint.green("[x]") : "[ ]"} ${model.label}${already.includes(model.id) ? paint.gray(" (already in the list)") : ""}`,
        detail: modelDetails(model, { prices }),
        disabled: blockedReason(model, false),
      }
    })
    const answer = await prompt.choosePaged(
      chosen.length
        ? `Which models? ${chosen.length} chosen`
        : "Which models? Choose one or more",
      choices,
      {
        noun: "models",
        pageSize: 8,
        searchHint: "Search by model ID or name",
        searchText: (choice) => {
          const model = models.find((entry) => entry.id === choice.value)
          return `${model?.id ?? ""} ${model?.name ?? ""}`
        },
        view,
        // Once something is chosen, Enter finishes rather than taking the
        // first model on the page back out.
        initial: chosen.length ? done : undefined,
        actions: [
          {
            value: done,
            label: chosen.length
              ? `Done: benchmark ${chosen.join(", ")}`
              : "Done",
          },
          { value: manual, label: "Enter a model / deployment ID" },
        ],
      }
    )
    if (answer === done) {
      if (chosen.length > 0)
        return {
          ids: chosen,
          models,
          priced:
            catalog && prices !== "local" && catalog.sources.prices
              ? {
                  label: `${provider.label}'s model list`,
                  fetchedAt: catalog.fetchedAt,
                  stale: prices === "stale",
                }
              : null,
        }
      warn("Choose at least one model, or a model ID.")
      continue
    }
    const id =
      answer === manual
        ? await prompt.ask("Model / deployment ID")
        : String(answer)
    if (!id || /[\x00-\x1f\x7f]/.test(id)) {
      warn("Enter a non-empty model ID without control characters.")
      continue
    }
    if (
      answer === manual &&
      provider.id === "ollama" &&
      !models.some((m) => m.id === id)
    ) {
      warn("Choose an installed Ollama model; pull it in Ollama first.")
      continue
    }
    if (chosen.includes(id)) chosen.splice(chosen.indexOf(id), 1)
    else chosen.push(id)
  }
}

/**
 * Records a price for each chosen model, so the cost report and the charts
 * can say what the run cost. The list price, when the provider's list has
 * one; one saved earlier otherwise; and failing both, a price typed in or
 * none, in which case tokens are counted and cost is left empty. These prices
 * are the benchmark's: nothing here is a spend limit on the instance.
 */
async function recordPrices(
  prompt: Prompter,
  env: ProviderEnv,
  picked: Awaited<ReturnType<typeof pickModels>>
): Promise<void> {
  const provider = selectedProvider(env)
  if (isLocalProvider(provider.id)) {
    note("Local models cost nothing per token; the cost report shows $0.")
    return
  }
  const table = priceTable(env.AI_MODEL_PRICES)
  for (const id of picked.ids) {
    const key = usageModelId({ ...env, AI_MODEL: id })
    const listed = picked.models.find((m) => m.id === id)?.price
    const saved = validPrice(table[key]) ? table[key] : undefined
    say()
    if (listed && picked.priced) {
      const price = {
        inputPerMillion: listed.inputPerMillion,
        outputPerMillion: listed.outputPerMillion,
      }
      const same =
        saved?.inputPerMillion === price.inputPerMillion &&
        saved.outputPerMillion === price.outputPerMillion
      note(
        `${id}: ${formatPrice(price)}, from ${picked.priced.label}, fetched ${formatAge(picked.priced.fetchedAt)}${picked.priced.stale ? " (stale)" : ""}.`
      )
      if (listed.tiered)
        note("Tiered: the first tier's rate; long prompts cost more.")
      if (listed.variesByProvider)
        note("Representative: the upstream provider used may charge more.")
      if (
        saved &&
        !same &&
        !(await prompt.confirm(
          `Replace the price saved earlier (${formatPrice(saved)}) with it?`,
          true
        ))
      )
        continue
      table[key] = price
      continue
    }
    if (saved) {
      note(`${id}: ${formatPrice(saved)}, saved earlier.`)
      continue
    }
    if (provider.login) {
      note(
        `${id}: billed per month, not per token, so its calls count as $0. Record OpenAI's API price for it to see what the same calls would cost.`
      )
      if (!(await prompt.confirm("Record a price for it?", false))) continue
    } else {
      warn(`${id}: the provider's model list carries no price for it.`)
      if (
        !(await prompt.confirm(
          "Enter a price, so the report can say what it cost? Without one, tokens are counted and cost is left empty.",
          true
        ))
      )
        continue
    }
    const inputPerMillion = await prompt.askAmount("Input", {
      fallback: 0,
      unit: "USD per 1M tokens",
    })
    const outputPerMillion = await prompt.askAmount("Output", {
      fallback: 0,
      unit: "USD per 1M tokens",
    })
    table[key] = { inputPerMillion, outputPerMillion }
  }
  env.AI_MODEL_PRICES = JSON.stringify(table)
}

/**
 * Providers and models, one provider at a time: its credential (or sign-in),
 * then one or more of its models, then their prices; then another provider,
 * or done. `env` is the benchmark's environment, and gains every answer;
 * `updates` is what to save.
 */
export async function askModels(
  prompt: Prompter,
  env: ProviderEnv
): Promise<{ entries: ModelEntry[]; updates: Record<string, string> }> {
  const entries: ModelEntry[] = []
  const updates: Record<string, string> = {}
  let baseUrlFor: string | null = null
  for (;;) {
    const picked = await prompt.choose(
      entries.length
        ? "Which provider are the next models on?"
        : "Which provider are the models on?",
      PROVIDERS.map((entry) => ({
        value: entry.id,
        label: entry.login
          ? entry.label.replace(/\(sign in with pnpm ai login\)/, "(sign in)")
          : entry.label,
      })),
      Math.max(
        0,
        PROVIDERS.findIndex(
          (entry) => entry.id === (env.AI_PROVIDER || "gateway")
        )
      )
    )
    const scoped: ProviderEnv = { ...env, AI_PROVIDER: picked, AI_MODEL: "" }
    const provider = selectedProvider(scoped)
    if (provider.login) {
      if (!(await ensureSignedIn(prompt, scoped, updates))) continue
    } else {
      await askCredentials(prompt, scoped)
      if (!hasCredential(scoped)) {
        warn(
          `No credential for ${provider.label}, so its models cannot be called. Choose a provider again.`
        )
        continue
      }
    }
    if (provider.fields?.includes("AI_BASE_URL")) {
      if (
        baseUrlFor &&
        baseUrlFor !== picked &&
        scoped.AI_BASE_URL !== env.AI_BASE_URL
      )
        warn(
          "AI_BASE_URL is one setting, so one benchmark run can reach one OpenAI-compatible endpoint. The models chosen for the other one will use this address."
        )
      baseUrlFor = picked
    }
    // The provider's key and settings, into the benchmark's environment.
    for (const key of AI_ENV_KEYS) {
      if (PER_MODEL.has(key)) continue
      const value = scoped[key] ?? ""
      if (value !== (env[key] ?? "")) {
        env[key] = value
        updates[key] = value
      }
    }
    env.AI_PROVIDER = updates.AI_PROVIDER = picked

    const already = entries
      .filter((e) => e.provider === picked)
      .map((e) => e.model)
    const chosen = await pickModels(prompt, scoped, already)
    await recordPrices(prompt, scoped, chosen)
    env.AI_MODEL_PRICES = updates.AI_MODEL_PRICES = scoped.AI_MODEL_PRICES ?? ""
    for (const id of chosen.ids)
      if (!already.includes(id))
        entries.push({ provider: picked, model: id, label: id })

    say()
    say(
      `  ${paint.bold("Benchmarking")} ${entries.map((e) => `${e.provider}:${e.model}`).join(", ")}`
    )
    if (
      !(await prompt.confirm(
        "Add more models, from this provider or another?",
        false
      ))
    )
      break
  }
  updates.BENCH_MODELS = modelList(entries)
  return { entries, updates }
}
