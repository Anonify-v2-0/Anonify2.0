/**
 * A ChatGPT subscription as the instance's model, signed in with
 * `pnpm ai login --provider openai`.
 *
 * Four rules shape this file, and none of them is optional:
 *
 *  - **The token lives in the database, sealed.** `sealWithMasterKey` under
 *    ENCRYPTION_KEY, in one `Setting` row, never in `.env` — which is the file
 *    people paste into bug reports. Deleting the row is logging out.
 *  - **We mint our own or we do without.** Nothing here reads Codex CLI's,
 *    Claude Code's or any other tool's token store. Two tools sharing one
 *    refresh token log each other out at random, because refreshing rotates it.
 *  - **Refresh happens on use.** Every model call asks for a token; one that
 *    expires within a minute is refreshed first and the new one written back.
 *  - **Nothing secret reaches a message.** No token, authorization code or
 *    `state` appears in an error, a log line or an exception thrown from here,
 *    and no provider response body does either: a body can echo a credential.
 *
 * What this is not: sanctioned. OpenAI registers no OAuth client for third-
 * party inference on a subscription, so this uses the public client Codex CLI
 * ships with, as other open-source tools do, against the backend Codex uses.
 * What OpenAI's terms permit is OpenAI's to decide and can change; the login
 * command says so, and docs/ai-providers.md recommends an API key for anything
 * deployed. Anthropic's terms reserve subscription sign-in for its own apps,
 * so there is no Anthropic equivalent here at all.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import type { LanguageModel } from "ai"

import { prisma } from "@/lib/database/prisma"
import { openWithMasterKey, sealWithMasterKey } from "@/lib/storage/encryption"

import { DiscoveryError, type ModelDefinition } from "./discovery"

export const OPENAI_LOGIN = {
  issuer: "https://auth.openai.com",
  /** Codex CLI's public client; see the header for why it is this one. */
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  /** The only redirect that client has registered. */
  port: 1455,
  callbackPath: "/auth/callback",
  scope: "openid profile email offline_access",
  api: "https://chatgpt.com/backend-api/codex",
} as const

export const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_LOGIN.port}${OPENAI_LOGIN.callbackPath}`

export const LOGIN_SETTING_KEY = "ai.login.openai"

/** Refresh this long before expiry, so a token cannot lapse mid-request. */
const REFRESH_MARGIN_MS = 60_000

/** How we introduce ourselves to the backend: as what we are. */
const ORIGINATOR = "anonify"

/**
 * The backend requires `instructions`. Every analysis call has a system prompt
 * that becomes them; this is only for a call without one, such as the probe.
 */
const DEFAULT_INSTRUCTIONS =
  "Follow the user's request and answer in the format it asks for."

export type StoredLogin = {
  access: string
  refresh: string
  /** Milliseconds since the epoch. */
  expiresAt: number
  /** The ChatGPT workspace the backend bills, from the token's claims. */
  accountId?: string
}

/** A sign-in failure the CLI can print as it is: it never carries a secret. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LoginError"
  }
}

/**
 * No usable sign-in at call time. A 401 by shape, so the throttle classifies
 * it as `authorization`: not retried, and reported to the reviewer exactly as
 * a rejected key is.
 */
export class SubscriptionAuthError extends Error {
  readonly statusCode = 401
  constructor(message: string) {
    super(message)
    this.name = "SubscriptionAuthError"
  }
}

// --- the authorization request -----------------------------------------------

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url")
}

export type Pkce = { verifier: string; challenge: string; state: string }

export function newPkce(): Pkce {
  const verifier = base64url(randomBytes(32))
  return {
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
    state: base64url(randomBytes(32)),
  }
}

export function authorizeUrl(pkce: Pkce): string {
  const url = new URL("/oauth/authorize", OPENAI_LOGIN.issuer)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_LOGIN.clientId,
    redirect_uri: OPENAI_REDIRECT_URI,
    scope: OPENAI_LOGIN.scope,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: ORIGINATOR,
  }).toString()
  return url.toString()
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * The authorization code from where the browser was sent: the loopback
 * callback's query, or the whole address pasted from a headless session.
 *
 * `state` is checked before the code is even looked at. A mismatch is somebody
 * else's redirect, and the message says so without repeating either value.
 */
export function codeFromRedirect(redirect: string, state: string): string {
  const text = redirect.trim()
  let params: URLSearchParams
  try {
    params = text.includes("://")
      ? new URL(text).searchParams
      : new URLSearchParams(text.replace(/^[^?]*\?/, ""))
  } catch {
    throw new LoginError("That is not the address the browser was sent to.")
  }
  const error = params.get("error")
  if (error) {
    // An OAuth error code is a fixed vocabulary, not a secret; anything else
    // in that position is not repeated.
    throw new LoginError(
      /^[a-z_]{1,64}$/.test(error)
        ? `The sign-in was refused (${error}).`
        : "The sign-in was refused."
    )
  }
  const returned = params.get("state")
  if (!returned || !sameSecret(returned, state))
    throw new LoginError(
      "The redirect is not from this sign-in attempt. Start again with pnpm ai login."
    )
  const code = params.get("code")
  if (!code) throw new LoginError("The redirect carries no authorization code.")
  return code
}

// --- tokens ------------------------------------------------------------------

function claims(jwt: unknown): Record<string, unknown> {
  if (typeof jwt !== "string") return {}
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")
    )
    return payload && typeof payload === "object" ? payload : {}
  } catch {
    return {}
  }
}

/**
 * The workspace to bill, read from the token's own claims. Not a signature
 * check: the token came straight from the issuer over TLS, and the backend
 * verifies it on every call anyway.
 */
export function accountIdOf(...tokens: unknown[]): string | undefined {
  for (const token of tokens) {
    const payload = claims(token)
    const auth = payload["https://api.openai.com/auth"] as
      Record<string, unknown> | undefined
    for (const candidate of [
      payload.chatgpt_account_id,
      auth?.chatgpt_account_id,
      (payload.organizations as { id?: unknown }[] | undefined)?.[0]?.id,
    ]) {
      if (typeof candidate === "string" && candidate) return candidate
    }
  }
}

async function tokenRequest(
  body: Record<string, string>,
  fetcher: typeof fetch,
  now: number
): Promise<StoredLogin> {
  let response: Response
  try {
    response = await fetcher(new URL("/oauth/token", OPENAI_LOGIN.issuer), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new LoginError("Could not reach the OpenAI sign-in service.")
  }
  if (!response.ok) {
    // Status only. The body is the issuer's, and may quote what it was sent.
    throw Object.assign(
      new LoginError(
        `The OpenAI sign-in service refused the request (HTTP ${response.status}).`
      ),
      { status: response.status }
    )
  }
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >
  const access = json.access_token
  const refresh = json.refresh_token
  if (typeof access !== "string" || !access)
    throw new LoginError("The sign-in service returned no access token.")
  const lifetime =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? json.expires_in * 1000
      : undefined
  const exp = claims(access).exp
  return {
    access,
    refresh: typeof refresh === "string" ? refresh : body.refresh_token || "",
    expiresAt: lifetime
      ? now + lifetime
      : typeof exp === "number"
        ? exp * 1000
        : now + 60 * 60_000,
    accountId: accountIdOf(json.id_token, access),
  }
}

export function exchangeCode(
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
  now = Date.now()
): Promise<StoredLogin> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: OPENAI_LOGIN.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_REDIRECT_URI,
    },
    fetcher,
    now
  )
}

export async function refreshLogin(
  login: StoredLogin,
  fetcher: typeof fetch = fetch,
  now = Date.now()
): Promise<StoredLogin> {
  const next = await tokenRequest(
    {
      grant_type: "refresh_token",
      client_id: OPENAI_LOGIN.clientId,
      refresh_token: login.refresh,
      scope: OPENAI_LOGIN.scope,
    },
    fetcher,
    now
  )
  return { ...next, accountId: next.accountId ?? login.accountId }
}

// --- the sealed store --------------------------------------------------------

export async function saveLogin(login: StoredLogin): Promise<void> {
  const value = {
    version: 1,
    sealed: sealWithMasterKey(Buffer.from(JSON.stringify(login))).toString(
      "base64"
    ),
  }
  await prisma.setting.upsert({
    where: { key: LOGIN_SETTING_KEY },
    create: { key: LOGIN_SETTING_KEY, value },
    update: { value },
  })
}

/**
 * The stored sign-in, or null when there is none. A row that will not open —
 * a different ENCRYPTION_KEY, a hand-edited value — is reported as exactly
 * that rather than as "not signed in", which would send somebody to log in
 * again without learning that their key changed.
 */
export async function loadLogin(): Promise<StoredLogin | null> {
  const row = await prisma.setting.findUnique({
    where: { key: LOGIN_SETTING_KEY },
  })
  if (!row) return null
  try {
    const value = row.value as { sealed?: unknown }
    if (typeof value?.sealed !== "string") throw new Error("malformed")
    const login = JSON.parse(
      openWithMasterKey(Buffer.from(value.sealed, "base64")).toString("utf8")
    ) as StoredLogin
    if (
      typeof login.access !== "string" ||
      typeof login.refresh !== "string" ||
      typeof login.expiresAt !== "number"
    )
      throw new Error("malformed")
    return login
  } catch {
    throw new SubscriptionAuthError(
      "The stored ChatGPT sign-in cannot be opened with this ENCRYPTION_KEY. Run pnpm ai login --provider openai again."
    )
  }
}

export async function deleteLogin(): Promise<boolean> {
  const { count } = await prisma.setting.deleteMany({
    where: { key: LOGIN_SETTING_KEY },
  })
  return count > 0
}

/** One refresh in flight per process: rotating twice at once logs us out. */
let refreshing: Promise<StoredLogin> | null = null

/**
 * A usable sign-in, refreshed first when it is about to expire.
 *
 * Another process — the app beside the CLI, a second replica — may have
 * rotated the refresh token already. So before refreshing, and again after a
 * refusal, the row is read back: a newer token there is used rather than
 * reported as a failed sign-in.
 */
export async function currentLogin(
  fetcher: typeof fetch = fetch,
  now = () => Date.now()
): Promise<StoredLogin> {
  let login: StoredLogin | null
  try {
    login = await loadLogin()
  } catch (error) {
    if (error instanceof SubscriptionAuthError) throw error
    throw new SubscriptionAuthError(
      "The stored ChatGPT sign-in could not be read from the database."
    )
  }
  if (!login)
    throw new SubscriptionAuthError(
      "Not signed in. Run pnpm ai login --provider openai."
    )
  if (login.expiresAt - REFRESH_MARGIN_MS > now()) return login
  if (!login.refresh)
    throw new SubscriptionAuthError(
      "The ChatGPT sign-in has expired. Run pnpm ai login --provider openai."
    )

  const stale = login
  refreshing ??= (async () => {
    try {
      const next = await refreshLogin(stale, fetcher, now())
      await saveLogin(next)
      return next
    } catch {
      const latest = await loadLogin().catch(() => null)
      if (latest && latest.refresh !== stale.refresh) return latest
      throw new SubscriptionAuthError(
        "The ChatGPT sign-in has expired or was revoked. Run pnpm ai login --provider openai."
      )
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

// --- the transport -----------------------------------------------------------

type Json = Record<string, unknown>

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object" && typeof part.text === "string"
        ? part.text
        : ""
    )
    .filter(Boolean)
    .join("\n")
}

/**
 * A Responses API request, as the Codex backend takes it: system messages
 * moved into `instructions`, which it requires; nothing stored; streamed,
 * which is the only way it answers; and no token cap, which it refuses.
 */
export function toCodexRequest(body: Json): Json {
  const input = Array.isArray(body.input) ? (body.input as Json[]) : []
  const system = input.filter(
    (item) => item.role === "system" || item.role === "developer"
  )
  const instructions = [
    typeof body.instructions === "string" ? body.instructions : "",
    ...system.map((item) => textOf(item.content)),
  ]
    .filter(Boolean)
    .join("\n\n")
  const request: Json = {
    ...body,
    input: input.filter((item) => !system.includes(item)),
    instructions: instructions || DEFAULT_INSTRUCTIONS,
    store: false,
    stream: true,
  }
  delete request.max_output_tokens
  delete request.max_completion_tokens
  return request
}

/**
 * The streamed answer, collected into the single response a non-streaming
 * call expects: the `response.completed` event carries the whole response
 * object. A stream that fails or ends without one becomes a 502, which the
 * throttle treats as the provider's failure.
 */
export async function fromCodexStream(response: Response): Promise<Response> {
  const text = await response.text()
  let completed: unknown
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
    if (!data || data === "[DONE]") continue
    let event: Json
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    if (
      (event.type === "response.completed" || event.type === "response.done") &&
      event.response
    )
      completed = event.response
  }
  if (!completed)
    return new Response(
      JSON.stringify({
        error: {
          message: "The ChatGPT backend did not complete the response.",
          type: "server_error",
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    )
  return new Response(JSON.stringify(completed), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

export function codexFetch(inner: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (
      init?.method !== "POST" ||
      typeof init.body !== "string" ||
      !new URL(url).pathname.endsWith("/responses")
    )
      return inner(input, init)
    const response = await inner(input, {
      ...init,
      body: JSON.stringify(toCodexRequest(JSON.parse(init.body))),
    })
    return response.ok ? fromCodexStream(response) : response
  }) as typeof fetch
}

function backendHeaders(login: StoredLogin): Record<string, string> {
  return {
    originator: ORIGINATOR,
    "OpenAI-Beta": "responses=experimental",
    ...(login.accountId ? { "chatgpt-account-id": login.accountId } : {}),
  }
}

export async function subscriptionModel(
  modelId: string,
  fetcher: typeof fetch = fetch
): Promise<LanguageModel> {
  const login = await currentLogin(fetcher)
  const { createOpenAI } = await import("@ai-sdk/openai")
  return createOpenAI({
    baseURL: OPENAI_LOGIN.api,
    apiKey: login.access,
    headers: backendHeaders(login),
    fetch: codexFetch(fetcher),
  }).responses(modelId)
}

/**
 * Sent as `client_version` on the model list. Codex CLI sends its own version,
 * and the backend uses it to leave out models a client is too old to drive. We
 * drive every model the same way, through the Responses API, so we ask as a
 * current client rather than as any particular Codex release.
 */
const MODEL_LIST_CLIENT_VERSION = "1.0.0"

/**
 * The models this account's plan offers, read from OpenAI with the signed-in
 * token: the same list, in the same order, that Codex CLI's own picker shows.
 *
 * The shape is Codex's `ModelsResponse` (codex-rs/protocol, openai_models.rs):
 * `models[]` with `slug`, `display_name`, `visibility`, `priority`,
 * `input_modalities` and `context_window`. Only `visibility: "list"` models
 * are offered, as Codex does; a hidden one can still be typed and verified.
 * `input_modalities` is what the backend advertises, and setup's probe still
 * decides. It is not the public API's list, it may change, and setup falls
 * back to a typed, verified ID when it cannot be read.
 */
export async function discoverSubscriptionModels(
  fetcher: typeof fetch = fetch
): Promise<ModelDefinition[]> {
  let login: StoredLogin
  try {
    login = await currentLogin(fetcher)
  } catch (error) {
    throw new DiscoveryError(
      error instanceof SubscriptionAuthError
        ? error.message
        : "Sign in first with pnpm ai login --provider openai."
    )
  }
  let raw: unknown
  try {
    const response = await fetcher(
      `${OPENAI_LOGIN.api}/models?client_version=${MODEL_LIST_CLIENT_VERSION}`,
      {
        headers: {
          Authorization: `Bearer ${login.access}`,
          ...backendHeaders(login),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }
    )
    if (!response.ok)
      throw new DiscoveryError(
        response.status === 401 || response.status === 403
          ? `OpenAI refused the model list (HTTP ${response.status}). Run pnpm ai login --provider openai again.`
          : `Model discovery failed (HTTP ${response.status}). Enter a model ID to verify it.`
      )
    raw = await response.json()
  } catch (error) {
    if (error instanceof DiscoveryError) throw error
    throw new DiscoveryError(
      "The ChatGPT model list could not be read. Enter a model ID to verify it."
    )
  }
  const rows = (raw as { models?: unknown })?.models
  if (!Array.isArray(rows))
    throw new DiscoveryError(
      "The ChatGPT backend returned no model list. Enter a model ID to verify it."
    )
  const listed: { model: ModelDefinition; priority: number }[] = []
  for (const row of rows as Json[]) {
    if (!row || typeof row !== "object") continue
    const id = row.slug
    if (typeof id !== "string" || !id || /[\x00-\x1f\x7f]/.test(id)) continue
    // Absent means an older payload, which Codex shows; anything but "list" it hides.
    if (row.visibility !== undefined && row.visibility !== "list") continue
    const model: ModelDefinition = { id, label: id, textOutput: true }
    const name = row.display_name
    if (
      typeof name === "string" &&
      name &&
      name.length <= 80 &&
      !/[\x00-\x1f\x7f]/.test(name) &&
      name !== id
    )
      model.name = name
    const input = row.input_modalities
    if (Array.isArray(input)) model.vision = input.includes("image")
    const context = row.context_window
    if (
      typeof context === "number" &&
      Number.isInteger(context) &&
      context > 0 &&
      context <= 100_000_000
    )
      model.contextWindow = context
    listed.push({
      model,
      priority:
        typeof row.priority === "number" && Number.isFinite(row.priority)
          ? row.priority
          : Number.MAX_SAFE_INTEGER,
    })
  }
  return listed
    .sort(
      (a, b) => a.priority - b.priority || a.model.id.localeCompare(b.model.id)
    )
    .map((entry) => entry.model)
}
