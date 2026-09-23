/**
 * A cached copy of each provider's model list, with where it came from and
 * when.
 *
 * Setup used to ask the provider for its whole catalog every run. That is a
 * network round trip, sometimes a slow one, to learn what was true an hour
 * ago — and it left nowhere to put the one thing a model list can carry that
 * setup could not otherwise show: a published price.
 *
 * Three rules shape everything here:
 *
 *  - **A cache is a copy, never an authority.** Capabilities it lists are
 *    what the provider *advertises*; setup's live probe still verifies a model
 *    before it is saved. Prices it lists are for reading; nothing in the app
 *    enforces them unless the operator adopts one into `AI_MODEL_PRICES`.
 *  - **Stale is shown, not hidden.** A catalog past its expiry is still
 *    displayed when a refresh fails, labelled with its age, because "prices as
 *    of Tuesday" is more useful than nothing and less misleading than silence.
 *  - **A bad file is no file.** Anything that does not parse against the
 *    schema, or describes a different account or endpoint, is ignored and
 *    refetched. A corrupt cache must never break setup.
 *
 * Only official model-list APIs are read, and only the ones setup already
 * calls. There is no scraping, no link following and no inference: see
 * `listPrice` in ./providers/discovery for which lists carry prices and why
 * the others do not.
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { PROVIDERS, selectedProvider } from "./providers"
import { ollamaUrl, providerId, type ProviderEnv } from "./providers/config"
import {
  discoverModels,
  DiscoveryError,
  type ModelDefinition,
} from "./providers/discovery"

export const CATALOG_SCHEMA = 1
/** Bumped whenever a parser changes what it extracts, so old caches refetch. */
export const PARSER_VERSION = 1

const HOUR = 60 * 60 * 1000
/** Prices change without notice; a day-old list price is the limit of useful. */
export const PRICE_TTL_MS = 24 * HOUR
/** Capabilities change with model releases, which are rarer. */
export const MODEL_TTL_MS = 7 * 24 * HOUR

/**
 * Read with no credential at all. `pnpm models:warm --all` refreshes these
 * even for providers you have not configured.
 */
export const PUBLIC_CATALOGS = new Set(["gateway", "deepinfra"])

/** Cloud providers authenticate from ambient credential chains. */
const AMBIENT = new Set(["azure", "amazon-bedrock", "google-vertex"])

const modelSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  label: z.string().min(1).max(512),
  name: z.string().max(80).optional(),
  contextWindow: z.number().int().positive().optional(),
  textOutput: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  vision: z.boolean().optional(),
  unavailable: z.string().max(200).optional(),
  price: z
    .object({
      inputPerMillion: z.number().nonnegative(),
      outputPerMillion: z.number().nonnegative(),
      tiered: z.boolean().optional(),
      variesByProvider: z.boolean().optional(),
    })
    .optional(),
})

const catalogSchema = z.object({
  schema: z.literal(CATALOG_SCHEMA),
  parser: z.literal(PARSER_VERSION),
  provider: z.string().regex(/^[a-z0-9-]+$/),
  /** Which endpoint or account this describes. Never a credential. */
  target: z.string(),
  /** Where each kind of field came from. */
  sources: z.object({
    models: z.string().min(1),
    prices: z.string().min(1).optional(),
  }),
  fetchedAt: z.iso.datetime(),
  modelsExpireAt: z.iso.datetime(),
  pricesExpireAt: z.iso.datetime(),
  models: z.array(modelSchema).max(20_000),
})

export type ProviderCatalog = z.infer<typeof catalogSchema>

export type Freshness = "fresh" | "stale"

export function catalogDirectory(env: ProviderEnv = process.env): string {
  return (
    env.ANONIFY_MODEL_CACHE_PATH?.trim() ||
    process.env.ANONIFY_MODEL_CACHE_PATH?.trim() ||
    path.join(process.cwd(), ".cache", "models")
  )
}

/**
 * The account or endpoint a catalog describes, so a cache written for one
 * Azure resource or Ollama server is never shown for another. Deliberately
 * nothing secret: the file sits on disk in plain text.
 */
export function catalogTarget(env: ProviderEnv): string {
  const id = providerId(env)
  let ollama = ""
  if (id === "ollama") {
    try {
      ollama = ollamaUrl(env, false)
    } catch {
      ollama = "invalid"
    }
  }
  return JSON.stringify([
    id,
    ollama,
    env.AZURE_SUBSCRIPTION_ID || "",
    env.AZURE_RESOURCE_GROUP || "",
    env.AZURE_RESOURCE_NAME || "",
    env.AWS_REGION || "",
    env.GOOGLE_VERTEX_PROJECT || "",
    env.GOOGLE_VERTEX_LOCATION || "",
    id === "fireworks" ? env.FIREWORKS_ACCOUNT_ID || "" : "",
  ])
}

/** Where the model list is read from, for the record. */
export function catalogSource(env: ProviderEnv): string {
  const provider = selectedProvider(env)
  if (provider.id === "fireworks" && env.FIREWORKS_ACCOUNT_ID)
    return `https://api.fireworks.ai/v1/accounts/${encodeURIComponent(env.FIREWORKS_ACCOUNT_ID)}/models`
  return provider.modelsUrl ?? `${provider.label} model API`
}

function catalogFile(directory: string, provider: string): string {
  if (!/^[a-z0-9-]+$/.test(provider))
    throw new Error(`Not a provider ID: ${provider}`)
  return path.join(directory, `${provider}.json`)
}

export function freshness(
  catalog: ProviderCatalog,
  now = new Date()
): { models: Freshness; prices: Freshness | undefined } {
  const stale = (iso: string) =>
    Date.parse(iso) <= now.getTime() ? "stale" : "fresh"
  return {
    models: stale(catalog.modelsExpireAt),
    prices: catalog.sources.prices ? stale(catalog.pricesExpireAt) : undefined,
  }
}

/** Fresh only if everything it tracks is: a priced catalog lasts a day. */
export function isFresh(catalog: ProviderCatalog, now = new Date()): boolean {
  const state = freshness(catalog, now)
  return state.models === "fresh" && state.prices !== "stale"
}

export function buildCatalog(
  env: ProviderEnv,
  models: ModelDefinition[],
  now = new Date()
): ProviderCatalog {
  const source = catalogSource(env)
  return {
    schema: CATALOG_SCHEMA,
    parser: PARSER_VERSION,
    provider: providerId(env),
    target: catalogTarget(env),
    sources: {
      models: source,
      ...(models.some((model) => model.price) ? { prices: source } : {}),
    },
    fetchedAt: now.toISOString(),
    modelsExpireAt: new Date(now.getTime() + MODEL_TTL_MS).toISOString(),
    pricesExpireAt: new Date(now.getTime() + PRICE_TTL_MS).toISOString(),
    // Built straight from discovery, before setup verifies anything: a model
    // that fails verification is marked for that session, never in the cache.
    models: models.map((model) => ({ ...model })),
  }
}

/** The cached catalog for this provider and target, or nothing. */
export async function readCatalog(
  env: ProviderEnv,
  directory = catalogDirectory(env)
): Promise<ProviderCatalog | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(catalogFile(directory, providerId(env)), "utf8")
    )
    const parsed = catalogSchema.safeParse(raw)
    if (!parsed.success) return
    if (
      parsed.data.provider !== providerId(env) ||
      parsed.data.target !== catalogTarget(env)
    )
      return
    return parsed.data
  } catch {
    return
  }
}

/**
 * Through a temporary file and a rename, so a reader never sees half a
 * catalog and an interrupted write leaves the previous one in place.
 */
export async function writeCatalog(
  catalog: ProviderCatalog,
  directory: string
): Promise<string> {
  await mkdir(directory, { recursive: true })
  const final = catalogFile(directory, catalog.provider)
  const temporary = `${final}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await rename(temporary, final)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  await writeManifest(catalog, directory)
  return final
}

const manifestSchema = z.object({
  schema: z.literal(CATALOG_SCHEMA),
  providers: z.record(
    z.string(),
    z.object({
      fetchedAt: z.iso.datetime(),
      models: z.number().int().nonnegative(),
      priced: z.number().int().nonnegative(),
      source: z.string(),
    })
  ),
})

/** A summary of what is cached. Informational; each provider file stands alone. */
async function writeManifest(
  catalog: ProviderCatalog,
  directory: string
): Promise<void> {
  const file = path.join(directory, "catalog-manifest.json")
  let providers: z.infer<typeof manifestSchema>["providers"] = {}
  try {
    const parsed = manifestSchema.safeParse(
      JSON.parse(await readFile(file, "utf8"))
    )
    if (parsed.success) providers = parsed.data.providers
  } catch {
    /* A missing or damaged manifest is rebuilt from this write. */
  }
  providers[catalog.provider] = {
    fetchedAt: catalog.fetchedAt,
    models: catalog.models.length,
    priced: catalog.models.filter((model) => model.price).length,
    source: catalog.sources.models,
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ schema: CATALOG_SCHEMA, providers }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    )
    await rename(temporary, file)
  } catch {
    await rm(temporary, { force: true })
  }
}

export type CatalogResult = {
  models: ModelDefinition[]
  /** What the models were read from; absent for a live, uncacheable list. */
  catalog?: ProviderCatalog
  origin: "cache" | "live" | "stale"
  /** Why a refresh did not happen, when the result is a stale cache. */
  error?: string
  /** Where the refreshed catalog was saved. */
  saved?: string
}

/** Ollama lists what is installed right now, locally and for free. */
export function cacheable(env: ProviderEnv): boolean {
  return providerId(env) !== "ollama"
}

function reason(error: unknown): string {
  // DiscoveryError messages are written to be safe to print; anything else
  // may carry a response body, and a response body may carry a key.
  return error instanceof DiscoveryError
    ? error.message
    : "The provider's model list could not be read."
}

/**
 * The provider's models, from the cache when it is fresh and from the
 * provider otherwise.
 *
 *  - `auto`: a fresh cache, else the provider, else a stale cache.
 *  - `force`: the provider, falling back to a stale cache.
 *  - `never`: the cache, however old, and no network at all.
 */
export async function loadCatalog(
  env: ProviderEnv,
  options: {
    refresh?: "auto" | "force" | "never"
    directory?: string
    now?: Date
    fetcher?: typeof fetch
  } = {}
): Promise<CatalogResult> {
  const { refresh = "auto", now = new Date() } = options
  if (!cacheable(env)) {
    if (refresh === "never")
      throw new DiscoveryError("Ollama models are always read live.")
    return {
      models: await discoverModels(env, options.fetcher),
      origin: "live",
    }
  }

  const directory = options.directory ?? catalogDirectory(env)
  const cached = await readCatalog(env, directory)
  if (refresh === "never") {
    if (!cached)
      throw new DiscoveryError(
        "No cached model list for this provider. Run pnpm models:warm while online."
      )
    return { models: cached.models, catalog: cached, origin: "cache" }
  }
  if (refresh === "auto" && cached && isFresh(cached, now))
    return { models: cached.models, catalog: cached, origin: "cache" }

  let models: ModelDefinition[]
  try {
    models = await discoverModels(env, options.fetcher)
  } catch (error) {
    if (!cached) throw error
    return {
      models: cached.models,
      catalog: cached,
      origin: "stale",
      error: reason(error),
    }
  }
  const catalog = buildCatalog(env, models, now)
  let saved: string | undefined
  try {
    saved = await writeCatalog(catalog, directory)
  } catch {
    // An unwritable cache costs a refetch next time, nothing more.
  }
  return { models, catalog, origin: "live", saved }
}

// --- warming ----------------------------------------------------------------

export type WarmRow = {
  provider: string
  status:
    "refreshed" | "fresh" | "stale" | "missing" | "unavailable" | "skipped"
  detail: string
  /** An attempted refresh that did not succeed. */
  failed?: boolean
}

/** Configured enough to ask for a model list without prompting anyone. */
function configured(id: string, env: ProviderEnv): boolean {
  const provider = PROVIDERS.find((entry) => entry.id === id)!
  if (id === "gateway")
    return Boolean(
      env.AI_GATEWAY_API_KEY?.trim() || env.VERCEL_OIDC_TOKEN?.trim()
    )
  // Credential chains and local servers cannot be detected without using
  // them, so they count only when they are the provider actually selected.
  if (AMBIENT.has(id) || id === "ollama") return id === providerId(env)
  return Boolean(provider.envKey && env[provider.envKey]?.trim())
}

export function formatAge(fetchedAt: string, now = new Date()): string {
  const minutes = Math.max(0, (now.getTime() - Date.parse(fetchedAt)) / 60_000)
  if (minutes < 2) return "just now"
  if (minutes < 120) return `${Math.round(minutes)} minutes ago`
  const hours = minutes / 60
  if (hours < 48) return `${Math.round(hours)} hours ago`
  return `${Math.round(hours / 24)} days ago`
}

function summary(catalog: ProviderCatalog): string {
  const priced = catalog.models.filter((model) => model.price).length
  return `${catalog.models.length} models${priced ? `, ${priced} with list prices` : ""}`
}

/**
 * Refreshes the cached catalogs, one provider at a time.
 *
 * By default only providers with credentials in the environment, plus the
 * selected one. `all` adds every provider, reading public catalogs without a
 * credential and reporting the rest as unavailable. Serial on purpose: one
 * request in flight, each with the discovery timeout and page limit, is the
 * rate limit.
 */
export async function warmCatalogs(
  env: ProviderEnv,
  options: {
    providers?: string[]
    all?: boolean
    force?: boolean
    offline?: boolean
    directory?: string
    now?: Date
    fetcher?: typeof fetch
  } = {}
): Promise<WarmRow[]> {
  const known = PROVIDERS.map((provider) => provider.id)
  for (const id of options.providers ?? []) {
    if (!known.includes(id))
      throw new Error(`Unknown provider "${id}". One of: ${known.join(", ")}.`)
  }
  const explicit = Boolean(options.providers?.length)
  const ids = explicit
    ? options.providers!
    : known.filter((id) => options.all || configured(id, env))
  const rows: WarmRow[] = []

  for (const id of ids) {
    const providerEnv = { ...env, AI_PROVIDER: id }
    if (!cacheable(providerEnv)) {
      rows.push({
        provider: id,
        status: "skipped",
        detail:
          "read live by setup; installed models change too often to cache",
      })
      continue
    }
    const directory = options.directory ?? catalogDirectory(env)
    const cached = await readCatalog(providerEnv, directory)
    const now = options.now ?? new Date()

    if (options.offline) {
      rows.push(
        cached
          ? {
              provider: id,
              status: isFresh(cached, now) ? "fresh" : "stale",
              detail: `${summary(cached)}, fetched ${formatAge(cached.fetchedAt, now)}`,
            }
          : { provider: id, status: "missing", detail: "not cached" }
      )
      continue
    }
    if (!explicit && !configured(id, env) && !PUBLIC_CATALOGS.has(id)) {
      rows.push({
        provider: id,
        status: "unavailable",
        detail: "no credentials configured",
      })
      continue
    }
    if (cached && !options.force && isFresh(cached, now)) {
      rows.push({
        provider: id,
        status: "fresh",
        detail: `${summary(cached)}, fetched ${formatAge(cached.fetchedAt, now)}`,
      })
      continue
    }
    try {
      const result = await loadCatalog(providerEnv, {
        refresh: "force",
        directory,
        now,
        fetcher: options.fetcher,
      })
      rows.push(
        result.origin === "stale"
          ? {
              provider: id,
              status: "stale",
              detail: `refresh failed: ${result.error} Kept the copy from ${formatAge(result.catalog!.fetchedAt, now)}.`,
              failed: true,
            }
          : {
              provider: id,
              status: "refreshed",
              detail: summary(result.catalog!),
            }
      )
    } catch (error) {
      rows.push({
        provider: id,
        status: "unavailable",
        detail: reason(error),
        failed: true,
      })
    }
  }
  return rows
}
