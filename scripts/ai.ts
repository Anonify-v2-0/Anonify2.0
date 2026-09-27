/**
 * The model layer, from the command line.
 *
 *   pnpm ai status                        what is configured, and whether it is verified
 *   pnpm ai verify [--model ID]           probe the configured model and declare it in .env
 *   pnpm ai login --provider openai       sign in with a ChatGPT subscription
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

import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { PROVIDERS, selectedProvider } from "@/lib/ai/providers"
import {
  capabilityDeclaration,
  capabilityTarget,
  compatibleBaseUrl,
  configuredCapabilities,
  modelId,
  ollamaUrl,
  providerId,
  usageModelId,
  type ProviderEnv,
} from "@/lib/ai/providers/config"
import { probeModel } from "@/lib/ai/providers/probe"

import { canOpenBrowser, openBrowser, startCallbackServer } from "./ai-login"
import { quoteEnvValue, updateEnv } from "./env-file"
import { chooseModel } from "./setup-ai"
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

    status                       provider, model, verification and sign-in state
    verify                       probe the configured model; write the result to .env
      --provider <id>            switch provider as well (written to .env)
      --model <id>               the model to verify (written to .env)
      --text-only                accept a model that cannot read images
      --print                    print the settings instead of writing .env
    login --provider openai      sign in with a ChatGPT subscription
      --no-browser               print the link rather than opening it
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
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    textOnly: false,
    print: false,
    browser: true,
    help: false,
  }
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
    else if (!token.startsWith("-") && !args.command) args.command = token
    else throw new Error(`Unknown option "${token}". See pnpm ai --help.`)
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

async function status(): Promise<void> {
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

  if (provider.login) {
    const { loadLogin } = await import("@/lib/ai/providers/subscription")
    try {
      const login = await loadLogin()
      if (!login) warn("Not signed in. Run pnpm ai login --provider openai.")
      else {
        const minutes = Math.round((login.expiresAt - Date.now()) / 60_000)
        ok(
          minutes > 0
            ? `Signed in; the access token expires in ${minutes} minutes and is refreshed on use`
            : "Signed in; the access token has expired and is refreshed on next use"
        )
      }
    } catch (error) {
      warn(
        error instanceof Error && error.name === "SubscriptionAuthError"
          ? error.message
          : "Could not read the stored sign-in. Check DATABASE_URL and that the database is migrated."
      )
    }
  }
  say()
}

// --- verify -------------------------------------------------------------------

async function verify(args: Args): Promise<void> {
  const before: ProviderEnv = { ...process.env }
  let env: ProviderEnv = { ...process.env }
  if (args.provider) {
    if (!PROVIDERS.some((entry) => entry.id === args.provider))
      throw new Error(
        `Unknown provider "${args.provider}". One of: ${PROVIDERS.map((entry) => entry.id).join(", ")}.`
      )
    if (args.provider !== providerId(env)) {
      env.AI_PROVIDER = args.provider
      env.AI_MODEL_CAPABILITIES = ""
      if (!args.model) env.AI_MODEL = ""
    }
  }
  if (args.model) env.AI_MODEL = args.model
  selectedProvider(env)

  const interactive = Boolean(process.stdin.isTTY)
  if (!modelId(env)) {
    if (!interactive)
      throw new Error("No model is configured. Name one with --model <id>.")
    const prompt = new Prompter(true)
    try {
      env = await chooseModel(prompt, env, before)
    } finally {
      prompt.close()
    }
    if (!modelId(env) || !configuredCapabilities(env).structuredOutput) {
      warn("Nothing verified, so nothing was changed.")
      process.exitCode = 1
      return
    }
  } else {
    note(
      `Verifying ${modelId(env)} on ${selectedProvider(env).label} with two small synthetic requests. Hosted providers may bill them.`
    )
    const checking = spin(
      "Verifying structured output and image input (up to two minutes per request)"
    )
    const result = await probeModel(env)
    checking.stop()
    if (!result.structuredOutput) {
      fail(
        "Structured-output verification failed. Check the model, its credentials, access and connectivity."
      )
      process.exitCode = 1
      return
    }
    if (!result.vision && !args.textOnly) {
      fail(
        "Image verification failed. Choose a vision model, or pass --text-only to have image analysis skipped and reported."
      )
      process.exitCode = 1
      return
    }
    env.AI_MODEL_CAPABILITIES = capabilityDeclaration(env, result)
    ok(
      result.vision
        ? "Structured output and image input verified."
        : "Structured output verified. Image analysis will be visibly skipped."
    )
  }

  const updates: Record<string, string> = {
    AI_PROVIDER: providerId(env),
    AI_MODEL: modelId(env),
    AI_MODEL_CAPABILITIES: env.AI_MODEL_CAPABILITIES ?? "",
  }
  // A price setup adopted for the chosen model, if the picker offered one.
  if (env.AI_MODEL_PRICES && env.AI_MODEL_PRICES !== before.AI_MODEL_PRICES)
    updates.AI_MODEL_PRICES = env.AI_MODEL_PRICES
  // Guards the declaration against a mismatch this command would write itself.
  if (
    JSON.parse(updates.AI_MODEL_CAPABILITIES).target !== capabilityTarget(env)
  )
    throw new Error("The verification does not match the configuration.")

  if (args.print || !existsSync(".env")) {
    if (!args.print)
      note("No .env here; set these where the app reads its environment:")
    for (const [key, value] of Object.entries(updates))
      say(`${key}=${quoteEnvValue(value)}`)
    return
  }
  writeFileSync(".env", updateEnv(readFileSync(".env", "utf8"), updates))
  ok(
    `Wrote ${Object.keys(updates).join(", ")} to .env. Restart the app to use it.`
  )
}

// --- login --------------------------------------------------------------------

async function login(args: Args): Promise<void> {
  if (!loginProvider(args)) return
  const subscription = await import("@/lib/ai/providers/subscription")
  const interactive = Boolean(process.stdin.isTTY)

  say()
  for (const line of SUBSCRIPTION_CAVEAT) note(line)
  say()

  const pkce = subscription.newPkce()
  const url = subscription.authorizeUrl(pkce)
  const server = await startCallbackServer(pkce.state)
  if (!server && !interactive)
    throw new Error(
      `Port ${subscription.OPENAI_LOGIN.port} is in use and there is no terminal to paste into. Free the port, or run this in a terminal.`
    )

  say(`  Open this address in a browser signed in to ChatGPT:`)
  say()
  say(`  ${url}`)
  say()
  if (server && args.browser && canOpenBrowser()) openBrowser(url)
  if (interactive)
    note(
      server
        ? "The browser returns here by itself. Without a browser on this machine, sign in elsewhere; the last page will fail to load a localhost address. Copy that whole address and paste it below."
        : `Port ${subscription.OPENAI_LOGIN.port} is in use, so paste the address the browser ends on (it will fail to load).`
    )

  const withdraw = new AbortController()
  const prompt = new Prompter(interactive)
  const pasted = async (): Promise<string> => {
    for (;;) {
      const text = await prompt.secret(
        "Redirected address (hidden)",
        "",
        withdraw.signal
      )
      if (withdraw.signal.aborted) return new Promise<string>(() => {})
      if (!text) continue
      try {
        return subscription.codeFromRedirect(text, pkce.state)
      } catch (error) {
        if (!(error instanceof subscription.LoginError)) throw error
        warn(error.message)
      }
    }
  }
  const timeout = new Promise<string>((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(new subscription.LoginError("No sign-in within ten minutes.")),
      10 * 60_000
    )
    timer.unref()
  })

  let code: string
  try {
    code = await Promise.race([
      ...(server ? [server.code] : []),
      ...(interactive ? [pasted()] : []),
      timeout,
    ])
  } finally {
    withdraw.abort()
    server?.close()
    prompt.close()
  }

  const exchanging = spin("Exchanging the code for a token")
  let token
  try {
    token = await subscription.exchangeCode(code, pkce.verifier)
  } finally {
    exchanging.stop()
  }
  await subscription.saveLogin(token)
  ok("Signed in. The token is sealed in the database and refreshed on use.")
  if (!token.accountId)
    warn("The token names no ChatGPT workspace; calls may be refused.")
  if (providerId() !== "openai-subscription")
    note(
      "To use it: pnpm ai verify --provider openai-subscription --model <model id>, or pnpm setup."
    )
  else if (!configuredCapabilities().structuredOutput)
    note("Next: pnpm ai verify, to choose and verify a model.")
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
      return status()
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
