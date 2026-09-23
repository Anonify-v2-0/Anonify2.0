/**
 * Refreshes the cached model catalogs `pnpm setup` reads.
 *
 *   pnpm models:warm                     providers with credentials in .env
 *   pnpm models:warm --provider openai   just one (repeatable)
 *   pnpm models:warm --all               every provider; public lists need no key
 *   pnpm models:warm --force             refetch even if the cache is fresh
 *   pnpm models:warm --offline           no network: report what is cached
 *
 * Writes .cache/models/<provider>.json, or under ANONIFY_MODEL_CACHE_PATH.
 * Prints provider names, counts and ages — never a credential and never a
 * provider's response body, which can echo either.
 *
 * Nothing here changes what the app enforces. A list price in the cache is
 * shown by setup, which asks before copying one into AI_MODEL_PRICES.
 */

// First, so every module below sees the configured environment.
import "dotenv/config"

import { catalogDirectory, warmCatalogs, type WarmRow } from "@/lib/ai/catalog"
import { fail, note, ok, paint, say, setColor, warn } from "./tty"

const HELP = `
  ${paint.bold("pnpm models:warm")} — refresh the model catalogs setup reads

    --provider <id>  only this provider (repeatable)
    --all            every provider; public catalogs are read without a key
    --force          refetch even when the cached copy is fresh
    --offline        no network: report what is cached and how old it is
    --no-color       plain text
    --help, -h       this

  Prices expire after a day and capabilities after a week. A stale copy is
  kept, and shown with its age, when a refresh fails.
`

function print(row: WarmRow): void {
  const line = `${paint.bold(row.provider.padEnd(16))} ${row.status.padEnd(11)} ${paint.gray(row.detail)}`
  if (row.status === "refreshed" || row.status === "fresh") ok(line)
  else if (row.failed) fail(line)
  else if (row.status === "stale" || row.status === "missing") warn(line)
  else note(`· ${line}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    say(HELP)
    return
  }
  if (args.includes("--no-color")) setColor(false)

  const providers: string[] = []
  for (const [index, arg] of args.entries()) {
    if (arg === "--provider") {
      const value = args[index + 1]
      if (!value || value.startsWith("--"))
        throw new Error(
          "--provider needs a provider ID, as in --provider openai"
        )
      providers.push(value)
    } else if (arg.startsWith("--provider=")) {
      providers.push(arg.slice("--provider=".length))
    }
  }
  const offline = args.includes("--offline")

  say()
  note(
    `${offline ? "Reading" : "Refreshing"} model catalogs in ${catalogDirectory()}`
  )
  say()
  const rows = await warmCatalogs(process.env, {
    providers,
    all: args.includes("--all"),
    force: args.includes("--force"),
    offline,
  })
  if (rows.length === 0)
    note("No provider has credentials configured. Try --all or --provider.")
  for (const row of rows) print(row)
  say()
  if (rows.some((row) => row.failed)) process.exitCode = 1
}

main().catch((error: unknown) => {
  say()
  fail(error instanceof Error ? error.message : String(error))
  say()
  process.exitCode = 1
})
