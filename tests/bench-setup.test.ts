import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { parseModels } from "@/benchmarks/lib/bench"
import {
  fileSettingStore,
  loadBenchEnv,
  newEncryptionKey,
  saveBenchEnv,
} from "@/benchmarks/lib/environment"
import { captureUsage } from "@/benchmarks/lib/pipeline"
import { money } from "@/benchmarks/lib/report"
import { modelList, priceTable } from "@/benchmarks/lib/setup"
import { SpendLedger, spendTable, spendTotal } from "@/benchmarks/lib/spend"

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "bench-setup-"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe("the benchmark's own environment", () => {
  it("fills in what the shell leaves unset, and never overrides the shell", async () => {
    const file = path.join(directory, ".env")
    await writeFile(
      file,
      "BENCH_MODELS=openai:gpt-5-mini\nOPENAI_API_KEY=sk-bench\n"
    )
    const target: Record<string, string | undefined> = {
      BENCH_MODELS: "anthropic:claude-haiku-4-5",
    }
    const saved = await loadBenchEnv(file, target)
    expect(target).toEqual({
      BENCH_MODELS: "anthropic:claude-haiku-4-5",
      OPENAI_API_KEY: "sk-bench",
    })
    // What the file holds is still known, so a saved list can be offered.
    expect(saved.get("BENCH_MODELS")).toBe("openai:gpt-5-mini")
  })

  it("is empty, not an error, before the first setup", async () => {
    const target = {}
    const saved = await loadBenchEnv(path.join(directory, "missing"), target)
    expect(saved.size).toBe(0)
    expect(target).toEqual({})
  })

  it("saves answers beside whatever was edited by hand", async () => {
    const file = path.join(directory, "nested", ".env")
    await saveBenchEnv({ BENCH_MODELS: "openai:gpt-5-mini" }, file)
    const first = await readFile(file, "utf8")
    expect(first).toContain("instead of .env")
    expect(first).toContain("BENCH_MODELS=openai:gpt-5-mini")

    await writeFile(file, `${first}# my note\nANONIFY_AI_CONCURRENCY=2\n`)
    await saveBenchEnv(
      { BENCH_MODELS: "openai:gpt-5-mini, openai:gpt-5", OPENAI_API_KEY: "" },
      file
    )
    const second = await readFile(file, "utf8")
    expect(second).toContain("# my note\nANONIFY_AI_CONCURRENCY=2")
    expect(second).toContain("BENCH_MODELS='openai:gpt-5-mini, openai:gpt-5'")
    expect(second).toContain("OPENAI_API_KEY=\n")
    expect(second.match(/BENCH_MODELS=/g)).toHaveLength(1)
  })
})

describe("the benchmark's sign-in store", () => {
  it("keeps, reads back and deletes a row, in a file", async () => {
    const store = fileSettingStore(path.join(directory, "store.json"))
    expect(await store.findUnique({ where: { key: "k" } })).toBeNull()
    await store.upsert({
      where: { key: "k" },
      create: { key: "k", value: { a: 1 } },
      update: { value: { a: 1 } },
    })
    await store.upsert({
      where: { key: "k" },
      create: { key: "k", value: { a: 2 } },
      update: { value: { a: 2 } },
    })
    expect(await store.findUnique({ where: { key: "k" } })).toEqual({
      key: "k",
      value: { a: 2 },
    })
    expect(await store.deleteMany({ where: { key: "k" } })).toEqual({
      count: 1,
    })
    expect(await store.deleteMany({ where: { key: "k" } })).toEqual({
      count: 0,
    })
  })

  it("holds a ChatGPT sign-in sealed under the benchmark's key, never in the clear", async () => {
    const file = path.join(directory, "store.json")
    const previous = (globalThis as { prisma?: unknown }).prisma
    vi.stubEnv("ENCRYPTION_KEY", newEncryptionKey())
    vi.stubEnv("DATABASE_URL", "")
    try {
      await captureUsage(undefined, { setting: fileSettingStore(file) })
      const { loadLogin, saveLogin } =
        await import("@/lib/ai/providers/subscription")
      const login = {
        access: "access-token-fixture",
        refresh: "refresh-token-fixture",
        expiresAt: 1_900_000_000_000,
      }
      await saveLogin(login)
      expect(await loadLogin()).toEqual(login)
      const raw = await readFile(file, "utf8")
      expect(raw).not.toContain("access-token-fixture")
      expect(raw).not.toContain("refresh-token-fixture")

      // Another key, such as the instance's, cannot open it.
      vi.stubEnv("ENCRYPTION_KEY", newEncryptionKey())
      await expect(loadLogin()).rejects.toThrow("ENCRYPTION_KEY")
    } finally {
      ;(globalThis as { prisma?: unknown }).prisma = previous
    }
  })
})

describe("the saved choices", () => {
  it("writes the model list so it reads back as the same entries", () => {
    const entries = [
      { provider: "openai", model: "gpt-5-mini", label: "gpt-5-mini" },
      { provider: "ollama", model: "llama3.1:8b", label: "Llama 8B" },
    ]
    expect(modelList(entries)).toBe(
      "openai:gpt-5-mini, ollama:llama3.1:8b=Llama 8B"
    )
    expect(parseModels(modelList(entries))).toEqual(entries)
  })

  it("starts a price table over when AI_MODEL_PRICES is not one", () => {
    expect(priceTable(undefined)).toEqual({})
    expect(priceTable("[1, 2]")).toEqual({})
    expect(priceTable("not json")).toEqual({})
    expect(
      priceTable(
        '{"openai:gpt-5-mini":{"inputPerMillion":1,"outputPerMillion":2}}'
      )
    ).toEqual({
      "openai:gpt-5-mini": { inputPerMillion: 1, outputPerMillion: 2 },
    })
  })
})

describe("what a run spent", () => {
  const rates = { inputPerMillion: 1, outputPerMillion: 10 }
  const call = (documentId: string, input: number, output: number) => ({
    documentId,
    inputTokens: input,
    outputTokens: output,
  })

  function ledger() {
    const spend = new SpendLedger()
    // A call before any phase begins (discovery, say) is nobody's.
    spend.record(call("x", 99, 99))
    spend.begin({ label: "A", model: "a", phase: "deterministic-first", rates })
    spend.record(call("d1", 1000, 100))
    spend.record(call("d1", 1000, 100))
    spend.record(call("d2", 2000, 200))
    spend.begin({ label: "A", model: "a", phase: "model-only", rates })
    spend.record(call("d1", 4000, 400))
    spend.begin({
      label: "B",
      model: "b",
      phase: "deterministic-first",
      rates: null,
    })
    spend.record(call("d1", 500, 50))
    return spend
  }

  it("counts calls, documents and tokens by model and phase, priced at its rates", () => {
    expect(ledger().rows()).toEqual([
      {
        label: "A",
        model: "a",
        phase: "deterministic-first",
        documents: 2,
        calls: 3,
        inputTokens: 4000,
        outputTokens: 400,
        costUsd: 0.008,
      },
      {
        label: "A",
        model: "a",
        phase: "model-only",
        documents: 1,
        calls: 1,
        inputTokens: 4000,
        outputTokens: 400,
        costUsd: 0.008,
      },
      {
        label: "B",
        model: "b",
        phase: "deterministic-first",
        documents: 1,
        calls: 1,
        inputTokens: 500,
        outputTokens: 50,
        costUsd: null,
      },
    ])
  })

  it("totals what was priced, and names what was not", () => {
    expect(spendTotal(ledger().rows())).toEqual({
      calls: 5,
      inputTokens: 8500,
      outputTokens: 850,
      costUsd: 0.016,
      unpriced: ["B"],
    })
    expect(spendTotal([]).costUsd).toBeNull()
  })

  it("tables each phase, a subtotal for a model with several, and a total marked as a floor", () => {
    const { head, body, total } = spendTable(ledger().rows(), {
      money,
      tokens: String,
    })
    expect(head).toHaveLength(7)
    expect(body).toEqual([
      ["A", "deterministic-first", "2", "3", "4000", "400", "$0.008"],
      ["", "model-only", "1", "1", "4000", "400", "$0.008"],
      ["", "all phases", "2", "4", "8000", "800", "$0.016"],
      ["B", "deterministic-first", "1", "1", "500", "50", "no price"],
    ])
    expect(total).toEqual(["total", "", "", "5", "8500", "850", "$0.016+"])
  })
})
