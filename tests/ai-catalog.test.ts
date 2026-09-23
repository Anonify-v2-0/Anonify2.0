import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildCatalog,
  freshness,
  isFresh,
  loadCatalog,
  MODEL_TTL_MS,
  PRICE_TTL_MS,
  readCatalog,
  warmCatalogs,
  writeCatalog,
} from "@/lib/ai/catalog"
import { listPrice, parseModel } from "@/lib/ai/providers/discovery"
import { ratesFor } from "@/lib/ai/rates"
import { DEEPINFRA_MODELS, GATEWAY_MODELS } from "./model-catalog-fixtures"

let directory = ""
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "anonify-catalog-"))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

const NOW = new Date("2026-09-23T12:00:00.000Z")
const hours = (count: number) => new Date(NOW.getTime() + count * 3_600_000)
const gatewayEnv = { AI_PROVIDER: "gateway", AI_GATEWAY_API_KEY: "gw-secret" }
const openaiEnv = { AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-secret" }

function serving(body: unknown) {
  return vi.fn<typeof fetch>(async () => Response.json(body))
}

describe("list prices", () => {
  it("reads the Gateway's per-token prices as per-million rates", () => {
    const [haiku, gemini, qwen, embedding, sonar] = GATEWAY_MODELS.data
    expect(listPrice("gateway", haiku)).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 5,
    })
    // Tiered by prompt length: the first tier, and said to be one.
    expect(listPrice("gateway", gemini)).toEqual({
      inputPerMillion: 1.25,
      outputPerMillion: 10,
      tiered: true,
    })
    expect(listPrice("gateway", qwen)).toMatchObject({ variesByProvider: true })
    // An embedding has no output price, and Sonar has neither: no price.
    expect(listPrice("gateway", embedding)).toBeUndefined()
    expect(listPrice("gateway", sonar)).toBeUndefined()
  })

  it("reads DeepInfra's cents per token, and only for token pricing", () => {
    const [qwen, glm, image] = DEEPINFRA_MODELS
    expect(listPrice("deepinfra", qwen)).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 6,
    })
    expect(listPrice("deepinfra", glm)).toEqual({
      inputPerMillion: 0.4,
      outputPerMillion: 1.75,
    })
    expect(listPrice("deepinfra", image)).toBeUndefined()
    // Deprecated models are reported, not offered.
    expect(parseModel("deepinfra", image)?.unavailable).toContain("deprecated")
    expect(parseModel("deepinfra", glm)?.unavailable).toBeUndefined()
  })

  it("trusts no price from a provider whose unit is undocumented", () => {
    const row = { id: "m", pricing: { input: 0.3, output: 0.3 } }
    for (const provider of ["togetherai", "openai", "xai", "mistral"])
      expect(listPrice(provider, row)).toBeUndefined()
    // A rate no model has is a unit error, not a price.
    expect(
      listPrice("gateway", { pricing: { input: "0.5", output: "0.5" } })
    ).toBeUndefined()
    expect(
      listPrice("gateway", { pricing: { input: "-1", output: "0.000001" } })
    ).toBeUndefined()
  })
})

describe("the cache", () => {
  it("round-trips atomically and records where it came from", async () => {
    const catalog = buildCatalog(
      gatewayEnv,
      GATEWAY_MODELS.data.map((row) => parseModel("gateway", row)!),
      NOW
    )
    const file = await writeCatalog(catalog, directory)
    expect(path.basename(file)).toBe("gateway.json")
    expect(await readCatalog(gatewayEnv, directory)).toEqual(catalog)
    expect(catalog.sources).toEqual({
      models: "https://ai-gateway.vercel.sh/v1/models",
      prices: "https://ai-gateway.vercel.sh/v1/models",
    })
    expect(catalog.pricesExpireAt).toBe(
      new Date(NOW.getTime() + PRICE_TTL_MS).toISOString()
    )
    expect(catalog.modelsExpireAt).toBe(
      new Date(NOW.getTime() + MODEL_TTL_MS).toISOString()
    )
    // No temporary files left behind, and a manifest beside the catalog.
    expect((await readdir(directory)).sort()).toEqual([
      "catalog-manifest.json",
      "gateway.json",
    ])
    const manifest = JSON.parse(
      await readFile(path.join(directory, "catalog-manifest.json"), "utf8")
    )
    expect(manifest.providers.gateway).toMatchObject({ models: 5, priced: 3 })
  })

  it("never writes a credential", async () => {
    const catalog = buildCatalog(
      gatewayEnv,
      [parseModel("gateway", GATEWAY_MODELS.data[0])!],
      NOW
    )
    const file = await writeCatalog(catalog, directory)
    expect(await readFile(file, "utf8")).not.toContain("gw-secret")
  })

  it("ignores a malformed, foreign or outdated file", async () => {
    const file = path.join(directory, "gateway.json")
    await writeFile(file, "{ not json")
    expect(await readCatalog(gatewayEnv, directory)).toBeUndefined()

    const catalog = buildCatalog(gatewayEnv, [], NOW)
    await writeFile(file, JSON.stringify({ ...catalog, parser: 0 }))
    expect(await readCatalog(gatewayEnv, directory)).toBeUndefined()
    await writeFile(
      file,
      JSON.stringify({
        ...catalog,
        models: [{ id: "bad\u0000id", label: "x" }],
      })
    )
    expect(await readCatalog(gatewayEnv, directory)).toBeUndefined()

    // A catalog for one Azure resource is not shown for another.
    const azure = { AI_PROVIDER: "azure", AZURE_RESOURCE_NAME: "one" }
    await writeCatalog(buildCatalog(azure, [], NOW), directory)
    expect(await readCatalog(azure, directory)).toBeDefined()
    expect(
      await readCatalog({ ...azure, AZURE_RESOURCE_NAME: "two" }, directory)
    ).toBeUndefined()
  })

  it("expires prices after a day and capabilities after a week", () => {
    const priced = buildCatalog(
      gatewayEnv,
      [parseModel("gateway", GATEWAY_MODELS.data[0])!],
      NOW
    )
    expect(freshness(priced, hours(23))).toEqual({
      models: "fresh",
      prices: "fresh",
    })
    expect(freshness(priced, hours(25))).toEqual({
      models: "fresh",
      prices: "stale",
    })
    expect(isFresh(priced, hours(25))).toBe(false)

    const unpriced = buildCatalog(openaiEnv, [{ id: "m", label: "m" }], NOW)
    expect(freshness(unpriced, hours(25)).prices).toBeUndefined()
    expect(isFresh(unpriced, hours(25))).toBe(true)
    expect(isFresh(unpriced, hours(24 * 7 + 1))).toBe(false)
  })
})

describe("loading", () => {
  it("uses a fresh cache without calling the provider", async () => {
    await loadCatalog(gatewayEnv, {
      directory,
      now: NOW,
      fetcher: serving(GATEWAY_MODELS),
    })
    const fetcher = serving(GATEWAY_MODELS)
    const result = await loadCatalog(gatewayEnv, {
      directory,
      now: hours(1),
      fetcher,
    })
    expect(result.origin).toBe("cache")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("refreshes a stale cache, and falls back to it with a safe reason", async () => {
    await loadCatalog(gatewayEnv, {
      directory,
      now: NOW,
      fetcher: serving(GATEWAY_MODELS),
    })
    const failing = vi.fn<typeof fetch>(
      async () => new Response("key gw-secret rejected", { status: 401 })
    )
    const result = await loadCatalog(gatewayEnv, {
      directory,
      now: hours(30),
      fetcher: failing,
    })
    expect(failing).toHaveBeenCalled()
    expect(result.origin).toBe("stale")
    expect(result.models).toHaveLength(5)
    expect(result.error).toContain("HTTP 401")
    expect(result.error).not.toContain("gw-secret")
  })

  it("fails plainly when there is no cache to fall back to", async () => {
    await expect(
      loadCatalog(gatewayEnv, {
        directory,
        fetcher: vi.fn<typeof fetch>(async () => {
          throw new Error("offline")
        }),
      })
    ).rejects.toThrow("could not reach")
    await expect(
      loadCatalog(gatewayEnv, { directory, refresh: "never" })
    ).rejects.toThrow("pnpm models:warm")
  })

  it("never caches Ollama, whose installed models change underneath it", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).endsWith("/api/tags")
          ? { models: [{ name: "local" }] }
          : { capabilities: ["completion"] }
      )
    )
    const result = await loadCatalog(
      { AI_PROVIDER: "ollama" },
      { directory, fetcher }
    )
    expect(result.origin).toBe("live")
    expect(await readdir(directory)).toEqual([])
  })
})

describe("pnpm models:warm", () => {
  it("refreshes configured providers only, by default", async () => {
    const fetcher = serving({ data: [{ id: "gpt-x" }] })
    const rows = await warmCatalogs(openaiEnv, {
      directory,
      now: NOW,
      fetcher,
    })
    expect(rows).toEqual([
      { provider: "openai", status: "refreshed", detail: "1 models" },
    ])
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://api.openai.com/v1/models"
    )
  })

  it("reads public catalogs without a key under --all and says what it skipped", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).includes("deepinfra") ? DEEPINFRA_MODELS : GATEWAY_MODELS
      )
    )
    const rows = await warmCatalogs(
      {},
      { all: true, directory, now: NOW, fetcher }
    )
    const byProvider = Object.fromEntries(
      rows.map((row) => [row.provider, row])
    )
    expect(byProvider.gateway).toMatchObject({
      status: "refreshed",
      detail: "5 models, 3 with list prices",
    })
    expect(byProvider.deepinfra.status).toBe("refreshed")
    expect(byProvider.anthropic).toMatchObject({
      status: "unavailable",
      detail: "no credentials configured",
    })
    expect(byProvider.ollama.status).toBe("skipped")
    // No credential was sent to a public catalog, because none was set.
    for (const [, init] of fetcher.mock.calls)
      expect(JSON.stringify(init?.headers ?? {})).not.toContain("Bearer")
    expect(rows.some((row) => row.failed)).toBe(false)
  })

  it("skips a fresh cache unless forced, and reports without network offline", async () => {
    await warmCatalogs(openaiEnv, {
      directory,
      now: NOW,
      fetcher: serving({ data: [{ id: "gpt-x" }] }),
    })
    const fetcher = serving({ data: [{ id: "gpt-x" }, { id: "gpt-y" }] })
    expect(
      (await warmCatalogs(openaiEnv, { directory, now: hours(1), fetcher }))[0]
        .status
    ).toBe("fresh")
    expect(fetcher).not.toHaveBeenCalled()

    expect(
      await warmCatalogs(openaiEnv, {
        directory,
        now: hours(1),
        fetcher,
        force: true,
      })
    ).toEqual([{ provider: "openai", status: "refreshed", detail: "2 models" }])

    const offline = vi.fn<typeof fetch>()
    const rows = await warmCatalogs(
      { ...openaiEnv, ANTHROPIC_API_KEY: "k" },
      { directory, now: hours(24 * 8), fetcher: offline, offline: true }
    )
    expect(rows.map((row) => [row.provider, row.status])).toEqual([
      ["openai", "stale"],
      ["anthropic", "missing"],
    ])
    expect(offline).not.toHaveBeenCalled()
  })

  it("marks a failed refresh without echoing what the provider said", async () => {
    const rows = await warmCatalogs(openaiEnv, {
      directory,
      fetcher: vi.fn<typeof fetch>(
        async () => new Response("sk-secret is invalid", { status: 403 })
      ),
    })
    expect(rows[0]).toMatchObject({ status: "unavailable", failed: true })
    expect(JSON.stringify(rows)).not.toContain("sk-secret")
  })

  it("refuses a provider it does not know", async () => {
    await expect(
      warmCatalogs({}, { providers: ["openrouter"], directory })
    ).rejects.toThrow('Unknown provider "openrouter"')
  })
})

it("checks any environment with the rules the app enforces", () => {
  const env = {
    AI_PROVIDER: "openai",
    AI_MODEL: "m",
    AI_MODEL_PRICES: JSON.stringify({
      "openai:m": { inputPerMillion: 1, outputPerMillion: 2 },
    }),
  }
  expect(ratesFor(env)).toEqual({ inputPerMillion: 1, outputPerMillion: 2 })
  expect(ratesFor({ ...env, AI_MODEL: "other" })).toBeNull()
  expect(
    ratesFor({
      AI_PROVIDER: "openai",
      AI_MODEL: "m",
      AI_PRICE_INPUT_PER_MTOK: "3",
      AI_PRICE_OUTPUT_PER_MTOK: "4",
    })
  ).toEqual({ inputPerMillion: 3, outputPerMillion: 4 })
})
