/**
 * Rate-limit CLI.
 *
 *   pnpm rate-limit show
 *   pnpm rate-limit set --requests 100 --window 60
 *   pnpm rate-limit set upload --requests 5 --window 60
 *   pnpm rate-limit reset
 *
 * Changes are written to the database rather than a file, for two reasons: a
 * self-hosted deployment behind Docker Compose has a database but no writable
 * source tree, and a value written here takes effect on the running server
 * without a restart.
 *
 * The deployed demo's defaults are separate from a self-hosted install's, so
 * neither has to be a compromise. `show` says where every effective value came
 * from, which is the difference between a setting you believe you made and one
 * that is actually in force.
 */

import {
  activeProfile,
  clearOverrides,
  defaultsFor,
  envOverrides,
  RATE_LIMIT_NAMES,
  resolveLimits,
  saveOverrides,
  storedOverrides,
  type PartialLimits,
  type RateLimitName,
} from "@/lib/security/rate-limit-config"

const USAGE = `
Anonify rate limits

Usage:
  pnpm rate-limit show                              Show the limits in force
  pnpm rate-limit set --requests N --window S       Set every limit
  pnpm rate-limit set <name> --requests N --window S  Set one limit
  pnpm rate-limit reset [name]                      Drop stored overrides
  pnpm rate-limit --help

Limits:
  ${RATE_LIMIT_NAMES.join(", ")}

Layers, later winning:
  defaults (by ANONIFY_PROFILE) -> ANONIFY_RATE_LIMIT_<NAME>=100/60 -> this CLI

Examples:
  pnpm rate-limit set --requests 500 --window 60
  pnpm rate-limit set upload --requests 20 --window 60
  pnpm rate-limit reset upload
`.trim()

type Args = {
  command: string
  target?: RateLimitName
  requests?: number
  window?: number
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "show", help: false }

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]

    if (token === "--help" || token === "-h") {
      args.help = true
    } else if (token === "--requests" || token === "-r") {
      args.requests = Number(argv[++i])
    } else if (token === "--window" || token === "-w") {
      args.window = Number(argv[++i])
    } else if (!token.startsWith("-")) {
      if ((RATE_LIMIT_NAMES as readonly string[]).includes(token)) {
        args.target = token as RateLimitName
      } else {
        throw new Error(
          `Unknown limit "${token}". Expected one of: ${RATE_LIMIT_NAMES.join(", ")}`
        )
      }
    } else {
      throw new Error(`Unknown option "${token}"`)
    }
  }

  if (argv.includes("--help") || argv.includes("-h")) args.help = true
  return args
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ")
}

async function show(): Promise<void> {
  const profile = activeProfile()
  const env = envOverrides()
  const stored = await storedOverrides()
  const resolved = resolveLimits(profile, env, stored)
  const defaults = defaultsFor(profile)

  console.log(`\nProfile: ${profile}${profile === "demo" ? "  (restrictive)" : "  (generous)"}\n`)
  console.log(
    `  ${pad("LIMIT", 12)}${pad("REQUESTS", 10)}${pad("WINDOW", 10)}${pad("SOURCE", 10)}DEFAULT`
  )

  for (const name of RATE_LIMIT_NAMES) {
    const limit = resolved.limits[name]
    const source = resolved.sources[name]
    const fallback = defaults[name]

    console.log(
      `  ${pad(name, 12)}${pad(String(limit.limit), 10)}${pad(
        `${limit.windowSeconds}s`,
        10
      )}${pad(source, 10)}${fallback.limit}/${fallback.windowSeconds}s`
    )
  }

  console.log(
    "\n  source: default = profile default, env = ANONIFY_RATE_LIMIT_*, database = set by this CLI\n"
  )

  if (Object.keys(stored).length > 0) {
    console.log("  Stored overrides are in force. `pnpm rate-limit reset` removes them.\n")
  }
}

async function set(args: Args): Promise<void> {
  if (!Number.isFinite(args.requests) || !Number.isFinite(args.window)) {
    throw new Error("Both --requests and --window are required for `set`.")
  }

  const requests = Number(args.requests)
  const window = Number(args.window)

  if (!Number.isInteger(requests) || requests < 1) {
    throw new Error("--requests must be a positive whole number")
  }
  if (!Number.isInteger(window) || window < 1) {
    throw new Error("--window must be a positive whole number of seconds")
  }

  const stored = await storedOverrides()
  const next: PartialLimits = { ...stored }
  const targets = args.target ? [args.target] : [...RATE_LIMIT_NAMES]

  for (const name of targets) {
    next[name] = { limit: requests, windowSeconds: window }
  }

  await saveOverrides(next)

  console.log(
    `\nSet ${targets.join(", ")} to ${requests} requests per ${window}s.\n`
  )
  await show()
}

async function reset(args: Args): Promise<void> {
  if (!args.target) {
    await clearOverrides()
    console.log("\nCleared every stored override.\n")
  } else {
    const stored = await storedOverrides()
    delete stored[args.target]
    await saveOverrides(stored)
    console.log(`\nCleared the stored override for ${args.target}.\n`)
  }

  await show()
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)

  if (args.help || args.command === "help") {
    console.log(USAGE)
    return
  }

  switch (args.command) {
    case "show":
      await show()
      break
    case "set":
      await set(args)
      break
    case "reset":
      await reset(args)
      break
    default:
      console.log(USAGE)
      process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  console.error(`\n  ${message}\n`)
  if (/DATABASE_URL|connect|ECONNREFUSED/i.test(message)) {
    console.error(
      "  The CLI stores limits in the database. Check DATABASE_URL, and that\n" +
        "  Postgres is running (`docker compose up -d`) and migrated\n" +
        "  (`pnpm db:migrate`).\n"
    )
  }

  process.exitCode = 1
})
