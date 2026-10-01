import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import { parseEnv, updateEnv } from "@/scripts/env-file"

/**
 * The benchmark's own environment, kept apart from the instance's.
 *
 * `bench:models` used to read `.env`, so benchmarking meant configuring the
 * instance: a key added for a model being measured became the key the app
 * used, a price recorded for a cost report became a spend limit, and a
 * ChatGPT sign-in for the benchmark landed in the instance's database. Now
 * everything the benchmark needs lives in one gitignored directory,
 * `benchmarks/.bench/`:
 *
 * - `.env`: provider keys and settings, BENCH_MODELS, AI_MODEL_PRICES, and an
 *   ENCRYPTION_KEY of its own for the sign-in below. `.env` is never read.
 * - `store.json`: the one database row a provider asks for, a ChatGPT
 *   sign-in, sealed under that ENCRYPTION_KEY exactly as the app seals it.
 *
 * Deleting the directory forgets the benchmark's setup and nothing else.
 */

export const BENCH_DIRECTORY = path.join(import.meta.dirname, "..", ".bench")
export const BENCH_ENV_FILE = path.join(BENCH_DIRECTORY, ".env")
export const BENCH_STORE_FILE = path.join(BENCH_DIRECTORY, "store.json")

/** The environment file as a message names it, relative and with slashes. */
export function benchEnvName(): string {
  return path.relative(process.cwd(), BENCH_ENV_FILE).split(path.sep).join("/")
}

const HEADER = [
  "# The benchmark's own environment, read by `pnpm bench:models` instead of .env.",
  "# Written by its setup; safe to edit by hand. Delete benchmarks/.bench/ to",
  "# start the setup over. Nothing here changes what the instance itself uses.",
  "",
].join("\n")

/**
 * Reads the benchmark's environment into `target`. A variable already set in
 * the shell wins, as it does for dotenv, so `BENCH_MODELS=… pnpm bench:models`
 * still overrides a saved list for one run. Returns what the file holds.
 */
export async function loadBenchEnv(
  file = BENCH_ENV_FILE,
  target: Record<string, string | undefined> = process.env
): Promise<Map<string, string>> {
  const values = existsSync(file)
    ? parseEnv(await readFile(file, "utf8"))
    : new Map<string, string>()
  for (const [key, value] of values)
    if (target[key] === undefined) target[key] = value
  return values
}

/**
 * Writes values into the benchmark's environment, keeping every other line
 * as it was. A blank value is written blank rather than dropped, so a key
 * somebody cleared stays cleared.
 */
export async function saveBenchEnv(
  updates: Record<string, string>,
  file = BENCH_ENV_FILE
): Promise<void> {
  const source = existsSync(file) ? await readFile(file, "utf8") : HEADER
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, updateEnv(source, updates), { mode: 0o600 })
}

/** A key for sealing the benchmark's sign-in; never the instance's. */
export function newEncryptionKey(): string {
  return randomBytes(32).toString("base64")
}

type Row = { key: string; value: unknown }

/**
 * `prisma.setting`, as far as a provider uses it, kept in a JSON file. The
 * subscription provider stores, reads and deletes its sign-in through these
 * three calls and no others; anything else is a bug worth hearing about.
 */
export function fileSettingStore(file = BENCH_STORE_FILE) {
  const read = async (): Promise<Record<string, unknown>> =>
    existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {}
  const write = async (rows: Record<string, unknown>) => {
    await mkdir(path.dirname(file), { recursive: true })
    // Written whole and renamed into place: a crash mid-write must not leave
    // half a token where the old one was.
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(rows, null, 2)}\n`, {
      mode: 0o600,
    })
    await rename(temporary, file)
  }
  return {
    async findUnique({ where }: { where: { key: string } }) {
      const rows = await read()
      return where.key in rows
        ? { key: where.key, value: rows[where.key] }
        : null
    },
    async upsert({
      where,
      create,
      update,
    }: {
      where: { key: string }
      create: Row
      update: { value: unknown }
    }) {
      const rows = await read()
      rows[where.key] = where.key in rows ? update.value : create.value
      await write(rows)
      return { key: where.key, value: rows[where.key] }
    },
    async deleteMany({ where }: { where: { key: string } }) {
      const rows = await read()
      if (!(where.key in rows)) return { count: 0 }
      delete rows[where.key]
      await write(rows)
      return { count: 1 }
    },
  }
}
