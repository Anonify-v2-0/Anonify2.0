/**
 * The model layer, from the command line.
 *
 *   pnpm ai status                        what is configured, whether it is verified,
 *                                         usage, and the ChatGPT account and plan
 *   pnpm ai verify [--model ID]           probe the configured model and declare it in .env
 *   pnpm ai login --provider openai       sign in with a ChatGPT subscription,
 *                                         then choose, verify and price a model
 *   pnpm ai logout --provider openai      delete the stored sign-in
 *
 * `verify` is setup's probe without the rest of setup: two small synthetic
 * requests, and the capability declaration written back to `.env` beside the
 * values already there. It is how a scripted install, or CI, turns "a model is
 * configured" into "a model is verified" without an interactive terminal.
 *
 * `login` keeps its token in the database, sealed under ENCRYPTION_KEY, never
 * in `.env`. See lib/ai/providers/subscription.ts for the rules that go with
 * that, and for why there is no `--provider anthropic`.
 */

// First, so every module below sees the configured environment.
import "dotenv/config"

import { selectedProvider } from "@/lib/ai/providers"
import {
  compatibleBaseUrl,
  configuredCapabilities,
  modelId,
  ollamaUrl,
  providerId,
  usageModelId,
  type ProviderEnv,
} from "@/lib/ai/providers/config"

import {
  configureModel,
  switchProvider,
  writeSettings,
  type Price,
} from "./ai-configure"
import { signIn } from "./ai-login"
import {
  accountLines,
  instanceUsageLines,
  planUsageLines,
  type Line,
} from "./ai-status"
import {
  fail,
  note,
  ok,
  paint,
  Prompter,
  say,
  setColor,
  spin,
  warn,
} from "./tty"

const HELP = `
  ${paint.bold("pnpm ai")} — the instance's AI provider

    status                       provider, model, verification, and usage by this
                                 instance; for a ChatGPT sign-in, the account,
                                 plan and the plan's usage limits too
      --offline                  do not ask OpenAI for the plan's usage
    verify                       probe the configured model; write the result to .env
      --provider <id>            switch provider as well (written to .env)
      --model <id>               the model to verify (written to .env)
      --text-only                accept a model that cannot read images
      --input-price <usd>        record a price per 1M input tokens (with
      --output-price <usd>         --output-price) in AI_MODEL_PRICES
      --print                    print the settings instead of writing .env
    login --provider openai      sign in with a ChatGPT subscription, then
                                 choose, verify and price a model as verify does
      --model <id>               verify this one without asking
      --no-browser               print the link rather than opening it
      (and verify's --text-only, --input-price, --output-price, --print)
    logout --provider openai     delete the stored sign-in
    --no-color                   plain text
    --help, -h                   this

  Keys stay in .env, where pnpm setup puts them. A sign-in is sealed in the
  database and never written to .env.
`

const ANTHROPIC_REFUSAL = [
  "Anthropic's terms reserve Claude subscription sign-in (Free, Pro and Max) for",
  "Anthropic's own apps, so Anonify does not offer it and will not reuse",
  "another tool's sign-in. Use an API key instead: choose Anthropic in",
  "pnpm setup, or set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY.",
]

const SUBSCRIPTION_CAVEAT = [
  "This signs in with the public client OpenAI ships with Codex CLI, against",
  "the backend Codex uses. OpenAI registers no client for other tools, and",
  "whether a subscription may be used this way is for OpenAI's terms to say;",
  "they can change. For a deployed instance, prefer an OpenAI API key.",
]

type Args = {
  command: string
  provider?: string
  model?: string
  textOnly: boolean
  print: boolean
  browser: boolean
  help: boolean
  offline: boolean
  price?: Price
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    textOnly: false,
    print: false,
    browser: true,
    help: false,
    offline: false,
  }
  let inputPrice: string | undefined
  let outputPrice: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    const value = () => {
      const next = argv[++i]
      if (!next || next.startsWith("-"))
        throw new Error(`${token} needs a value`)
      return next
    }
    if (token === "--help" || token === "-h") args.help = true
    else if (token === "--no-color") setColor(false)
    else if (token === "--provider") args.provider = value()
    else if (token === "--model") args.model = value()
    else if (token === "--text-only") args.textOnly = true
    else if (token === "--print") args.print = true
    else if (token === "--no-browser") args.browser = false
    else if (token === "--offline") args.offline = true
    else if (token === "--input-price") inputPrice = value()
    else if (token === "--output-price") outputPrice = value()
    else if (!token.startsWith("-") && !args.command) args.command = token
    else throw new Error(`Unknown option "${token}". See pnpm ai --help.`)
  }
  if (inputPrice !== undefined || outputPrice !== undefined) {
    if (inputPrice === undefined || outputPrice === undefined)
      throw new Error("Give --input-price and --output-price together.")
    const price = {
      inputPerMillion: Number(inputPrice.replace(/^\$/, "")),
      outputPerMillion: Number(outputPrice.replace(/^\$/, "")),
    }
    if (
      !Object.values(price).every(
        (amount) => Number.isFinite(amount) && amount >= 0
      )
    )
      throw new Error(
        "--input-price and --output-price are US dollars per million tokens, such as 1.25."
      )
    args.price = price
  }
  return args
}

function loginProvider(args: Args): "openai" | null {
  if (args.provider === "anthropic") {
    for (const line of ANTHROPIC_REFUSAL) warn(line)
    process.exitCode = 1
    return null
  }
  if (args.provider !== "openai")
    throw new Error("Name the provider: --provider openai")
  return "openai"
}

// --- status -------------------------------------------------------------------

async function status(args: Args): Promise<void> {
  const env: ProviderEnv = process.env
  const provider = selectedProvider(env)
  say()
  say(`  ${paint.bold("Provider")}  ${provider.label} (${provider.id})`)
  say(`  ${paint.bold("Model")}     ${modelId(env) || paint.gray("not set")}`)
  if (modelId(env))
    note(`Usage rows and prices are keyed as ${usageModelId(env)}`)
  try {
    if (provider.compatible) note(`Endpoint: ${compatibleBaseUrl(env, false)}`)
    if (provider.id === "ollama") note(`Endpoint: ${ollamaUrl(env, false)}`)
  } catch (error) {
    warn((error as Error).message)
  }
  if (provider.envKey) {
    const present = Boolean(env[provider.envKey]?.trim())
    if (present) ok(`${provider.envKey} is set`)
    else if (provider.keyOptional) note(`${provider.envKey} is blank`)
    else warn(`${provider.envKey} is not set, so AI detection is off`)
  }

  const capabilities = configuredCapabilities(env)
  if (!env.AI_MODEL_CAPABILITIES?.trim() && provider.id === "gateway")
    note(
      "Capabilities: assumed, as every Gateway install before verification existed"
    )
  else if (capabilities.structuredOutput)
    ok(
      `Verified: structured output${capabilities.vision ? " and images" : "; images are skipped and reported"}`
    )
  else
    warn(
      "Not verified for this model and endpoint. Run pnpm ai verify; until then the contextual pass reports itself unsupported."
    )

  if (provider.login) await subscriptionStatus(args)
  await instanceUsage(provider.id)
  say()
}

function print(lines: Line[]): void {
  for (const line of lines) {
    if (line.level === "say") {
      say()
      say(`  ${paint.bold(line.text)}`)
    } else if (line.level === "ok") ok(line.text)
    else if (line.level === "warn") warn(line.text)
    // Indented to line up with a warning's "! " and a check's "✓ ".
    else note(`  ${line.text}`)
  }
}

/**
 * Who is signed in, on which plan, and how much of the plan is used. The
 * account comes from the stored token's claims; the usage, unless --offline,
 * from OpenAI, which may refresh the token first, as any use does.
 */
async function subscriptionStatus(args: Args): Promise<void> {
  const subscription = await import("@/lib/ai/providers/subscription")
  let login
  try {
    login = await subscription.loadLogin()
  } catch (error) {
    warn(
      error instanceof Error && error.name === "SubscriptionAuthError"
        ? error.message
        : "Could not read the stored sign-in. Check DATABASE_URL and that the database is migrated."
    )
    return
  }
  if (!login) {
    warn("Not signed in. Run pnpm ai login --provider openai.")
    return
  }

  let usage:
    Awaited<ReturnType<typeof subscription.fetchSubscriptionUsage>> | undefined
  let usageError: string | undefined
  if (!args.offline) {
    const reading = spin("Reading the plan's usage from OpenAI")
    try {
      usage = await subscription.fetchSubscriptionUsage()
      // Reading may have refreshed the token; show the one now stored.
      login = (await subscription.loadLogin()) ?? login
    } catch (error) {
      usageError =
        error instanceof Error &&
        ["UsageError", "SubscriptionAuthError", "LoginError"].includes(
          error.name
        )
          ? error.message
          : "The plan's usage could not be read."
    } finally {
      reading.stop()
    }
  }

  const profile = login.profile ?? subscription.profileOf(login.access)
  print(accountLines({ ...login, profile }, Date.now(), usage?.plan))
  if (usage) print(planUsageLines(usage, Date.now()))
  else if (usageError) {
    say()
    say(`  ${paint.bold("Plan usage (from OpenAI)")}`)
    warn(usageError)
  }
}

/** What this instance has sent the selected provider, from its usage rows. */
async function instanceUsage(provider: string): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) return
  const { providerUsage } = await import("@/lib/ai/usage-report")
  try {
    print(instanceUsageLines(await providerUsage(provider), provider))
  } catch {
    say()
    note("Usage by this instance: the database could not be read.")
  }
}

// --- verify -------------------------------------------------------------------

/**
 * Chooses (with a terminal) or takes (`--model`), verifies and prices a model,
 * then writes it to `.env`. Shared by `verify` and by `login` once signed in.
 */
async function configure(args: Args, provider?: string): Promise<boolean> {
  const before: ProviderEnv = { ...process.env }
  const id = provider ?? args.provider ?? providerId(before)
  const env = switchProvider(before, id, args.model)
  const prompt = process.stdin.isTTY ? new Prompter(true) : undefined
  try {
    const updates = await configureModel({
      env,
      before,
      prompt,
      textOnly: args.textOnly,
      price: args.price,
    })
    if (!updates) return false
    writeSettings(updates, { print: args.print })
    return true
  } finally {
    prompt?.close()
  }
}

async function verify(args: Args): Promise<void> {
  if (!(await configure(args))) process.exitCode = 1
}

// --- login --------------------------------------------------------------------

async function login(args: Args): Promise<void> {
  if (!loginProvider(args)) return
  const subscription = await import("@/lib/ai/providers/subscription")
  const interactive = Boolean(process.stdin.isTTY)

  say()
  for (const line of SUBSCRIPTION_CAVEAT) note(line)
  say()

  const token = await signIn({
    browser: args.browser,
    interactive,
  })
  await subscription.saveLogin(token)
  ok("Signed in. The token is sealed in the database and refreshed on use.")
  if (!token.accountId)
    warn("The token names no ChatGPT workspace; calls may be refused.")

  // Signed in is not configured: carry on to the model, the same way verify
  // does, so one command leaves the instance using the subscription. Asked
  // first in a terminal; done at once when --model says which.
  let proceed = Boolean(args.model)
  if (!proceed && interactive) {
    const ask = new Prompter(true)
    try {
      say()
      proceed = await ask.confirm(
        "Choose a model from your ChatGPT plan and verify it now?",
        true
      )
    } finally {
      ask.close()
    }
  }
  if (!proceed) {
    note(
      "When you are ready: pnpm ai verify --provider openai-subscription, to choose and verify a model."
    )
    return
  }
  say()
  if (!(await configure(args, "openai-subscription"))) {
    note(
      "You are still signed in. Try another model with pnpm ai verify --provider openai-subscription."
    )
    process.exitCode = 1
  }
}

async function logout(args: Args): Promise<void> {
  if (!loginProvider(args)) return
  const { deleteLogin } = await import("@/lib/ai/providers/subscription")
  if (await deleteLogin())
    ok("Signed out: the sealed token was deleted from this instance.")
  else note("There was no stored sign-in.")
  note(
    "This does not revoke the token at OpenAI; it lapses when it expires. Sign out of other sessions at chatgpt.com to end it sooner."
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.command || args.command === "help") {
    say(HELP)
    if (!args.help && !args.command) process.exitCode = 1
    return
  }
  switch (args.command) {
    case "status":
      return status(args)
    case "verify":
      return verify(args)
    case "login":
      return login(args)
    case "logout":
      return logout(args)
    default:
      throw new Error(`Unknown command "${args.command}". See pnpm ai --help.`)
  }
}

main()
  .catch((error: unknown) => {
    // Every message thrown on these paths is written to be printed: none
    // carries a token, a code, a state value or a provider's response.
    const message = error instanceof Error ? error.message : String(error)
    fail(message)
    if (/DATABASE_URL|ECONNREFUSED|connect/i.test(message))
      note(
        "Sign-ins are stored in the database. Check DATABASE_URL, and that Postgres is running and migrated."
      )
    process.exitCode = 1
  })
  .finally(async () => {
    // A Prisma client left open keeps the process alive. Only one that was
    // actually created: touching the lazy proxy would create one to close.
    const client = (globalThis as { prisma?: { $disconnect(): Promise<void> } })
      .prisma
    await client?.$disconnect().catch(() => {})
  })
