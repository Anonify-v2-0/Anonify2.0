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
  /** The plan's rate-limit windows and credits, as Codex CLI's /status reads them. */
  usage: "https://chatgpt.com/backend-api/wham/usage",
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
  /** Who signed in and on which plan, from the ID token; shown by status. */
  profile?: LoginProfile
}

export type LoginProfile = {
  email?: string
  /** The raw plan type, such as "plus" or "pro"; see planName(). */
  plan?: string
  userId?: string
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

/**
 * Who signed in and on which plan, read from the claims the way Codex CLI
 * reads them (codex-rs/login, token_data.rs). The ID token is asked first,
 * then the access token, which carries the same claims; so a sign-in stored
 * before this was recorded still has an answer.
 */
export function profileOf(...tokens: unknown[]): LoginProfile | undefined {
  const profile: LoginProfile = {}
  for (const token of tokens) {
    const payload = claims(token)
    const auth = (payload["https://api.openai.com/auth"] ?? {}) as Record<
      string,
      unknown
    >
    const named = (payload["https://api.openai.com/profile"] ?? {}) as Record<
      string,
      unknown
    >
    const text = (value: unknown) =>
      typeof value === "string" && value.trim() && value.length <= 200
        ? value.trim()
        : undefined
    profile.email ??= text(payload.email) ?? text(named.email)
    profile.plan ??= text(auth.chatgpt_plan_type)
    profile.userId ??= text(auth.chatgpt_user_id) ?? text(auth.user_id)
  }
  return Object.keys(profile).some(
    (key) => profile[key as keyof LoginProfile] !== undefined
  )
    ? profile
    : undefined
}

/** Plan names as Codex CLI shows them (codex-rs/protocol, auth.rs). */
const PLAN_NAMES: Record<string, string> = {
  guest: "Guest",
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro (More)",
  prolite: "Pro",
  promax: "Pro (Max)",
  team: "Team",
  self_serve_business_prolite: "Self Serve Business ProLite",
  self_serve_business_usage_based: "Self Serve Business Usage Based",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  enterprise_cbp_usage_based: "Enterprise CBP Usage Based",
  enterprise: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
}

/** A plan's display name; one this list does not know is shown as sent. */
export function planName(plan: string): string {
  return PLAN_NAMES[plan.toLowerCase()] ?? plan
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
    profile: profileOf(json.id_token, access),
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
  return {
    ...next,
    accountId: next.accountId ?? login.accountId,
    // A refresh answer may carry no ID token; keep what the last one said.
    profile: next.profile ?? login.profile,
  }
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
 * call expects.
 *
 * The `response.completed` event carries the response object, but not its
 * answer: with `store: false` the Codex backend sends `output: []` there and
 * delivers each finished item only as a `response.output_item.done` event.
 * Taking the completed object alone handed the SDK an empty answer, and every
 * model then "answered, but not with JSON". So the finished items are
 * collected in stream order and put back into the response. A stream that
 * fails or ends without completing becomes an error the throttle can
 * classify.
 */
export async function fromCodexStream(response: Response): Promise<Response> {
  const text = await response.text()
  let completed: Json | undefined
  let failure: { message?: string; code?: string } | undefined
  /** Finished output items, by their position in the answer. */
  const items = new Map<number, Json>()
  const describe = (value: unknown) => {
    const bag = (value && typeof value === "object" ? value : {}) as Json
    return {
      message: typeof bag.message === "string" ? bag.message : undefined,
      code: typeof bag.code === "string" ? bag.code : undefined,
    }
  }
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
    const inner = (event.response ?? {}) as Json
    if (
      event.type === "response.output_item.done" &&
      event.item &&
      typeof event.item === "object"
    )
      items.set(
        typeof event.output_index === "number"
          ? event.output_index
          : items.size,
        event.item as Json
      )
    else if (
      (event.type === "response.completed" || event.type === "response.done") &&
      event.response &&
      typeof event.response === "object"
    )
      completed = event.response as Json
    else if (event.type === "response.failed") failure = describe(inner.error)
    else if (event.type === "response.incomplete")
      failure = {
        message: `The response stopped early (${String((inner.incomplete_details as Json | undefined)?.reason ?? "no reason given")}).`,
      }
    else if (event.type === "error") failure = describe(event.error ?? event)
  }
  // A backend that answered with one JSON object rather than a stream.
  if (!completed && !failure) {
    try {
      const whole = JSON.parse(text) as Json
      if (whole.object === "response" && Array.isArray(whole.output))
        completed = whole
    } catch {
      /* not JSON either */
    }
  }
  if (!completed) {
    // Said in the shape the OpenAI adapter reads, so the backend's own words
    // reach the probe's description (redacted there) instead of a generic
    // failure. Usage limits are a rate limit, whatever the plan calls them.
    const code = failure?.code ?? ""
    const status = /rate|usage_limit|quota|too_many/i.test(code)
      ? 429
      : /invalid|unsupported|not_found|bad_request/i.test(code)
        ? 400
        : 502
    const reason = failure?.message
      ? `${failure.message}${failure.code ? ` (${failure.code})` : ""}`
      : failure?.code
    return new Response(
      JSON.stringify({
        error: {
          message: reason
            ? `The ChatGPT backend failed the response: ${reason}`
            : "The ChatGPT backend did not complete the response.",
          type: status === 502 ? "server_error" : "invalid_request_error",
          code: failure?.code,
        },
      }),
      { status, headers: { "Content-Type": "application/json" } }
    )
  }
  // The answer, from the items streamed before completion, when the
  // completed object leaves them out.
  const output = Array.isArray(completed.output) ? completed.output : []
  if (output.length === 0 && items.size > 0)
    completed = {
      ...completed,
      output: [...items.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, item]) => item),
    }
  return new Response(JSON.stringify(completed), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * A refusal with the sign-in's own tokens taken out of its body. The body
 * goes on to the SDK's error, and from there, redacted again, to whoever ran
 * the probe; a backend that echoes the bearer token must not print it.
 */
async function scrubbed(
  response: Response,
  secrets: string[]
): Promise<Response> {
  let body = await response.text()
  for (const secret of secrets)
    if (secret.length >= 8) body = body.split(secret).join("[redacted]")
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function codexFetch(
  inner: typeof fetch,
  secrets: string[] = []
): typeof fetch {
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
    const body = JSON.parse(init.body) as Json
    const response = await inner(input, {
      ...init,
      body: JSON.stringify(toCodexRequest(body)),
    })
    if (!response.ok) return scrubbed(response, secrets)
    // A caller that asked for a stream — the Hush agent does — reads the
    // backend's events itself, as it would from the public API. Collecting
    // them into one object here handed it JSON where it expected events, and
    // it finished every reply with nothing in it. Only a caller that asked
    // for one answer gets the collected one.
    return body.stream === true ? response : fromCodexStream(response)
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
  const [{ createOpenAI }, { wrapLanguageModel }] = await Promise.all([
    import("@ai-sdk/openai"),
    import("ai"),
  ])
  const model = createOpenAI({
    baseURL: OPENAI_LOGIN.api,
    apiKey: login.access,
    headers: backendHeaders(login),
    fetch: codexFetch(fetcher, [login.access, login.refresh]),
  }).responses(modelId)
  // The backend stores nothing (`toCodexRequest` sends `store: false`), so a
  // multi-step call must not refer back to an earlier item by id: the SDK
  // does that unless it knows, and the second step of every tool loop failed
  // with "Item … not found". Told, it sends earlier items whole, and asks for
  // reasoning in the encrypted form that can be sent back that way.
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          openai: {
            ...(params.providerOptions?.openai ?? {}),
            store: false,
            include: ["reasoning.encrypted_content"],
          },
        },
      }),
    },
  })
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
 * `input_modalities`, `context_window` and `available_in_plans`. Only
 * `visibility: "list"` models are offered, as Codex does; a hidden one can
 * still be typed and verified. One whose plans exclude the signed-in plan is
 * shown disabled.
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
  const plan = (login.profile ?? profileOf(login.access))?.plan?.toLowerCase()
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
    // Offered to some plans and not this one: shown, but not choosable. The
    // list does not always know (a model it offers can still be refused),
    // which is what verification is for.
    const plans = row.available_in_plans
    if (
      plan &&
      Array.isArray(plans) &&
      plans.length > 0 &&
      !plans.includes(plan)
    )
      model.unavailable = `Not included in the ${planName(plan)} plan`
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

// --- the plan's usage ---------------------------------------------------------

export type UsageWindow = {
  usedPercent: number
  /** How long the window is, in seconds: 18000 is five hours. */
  windowSeconds: number
  /** When it resets, in milliseconds since the epoch. */
  resetsAt?: number
}

export type SubscriptionUsage = {
  plan?: string
  /** Whether the plan will take another request right now. */
  allowed?: boolean
  limitReached?: boolean
  /** What stopped it, when something has: "rate_limit_reached", say. */
  reachedType?: string
  windows: UsageWindow[]
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string }
  /** Separate limits, such as one per model family. */
  additional: { name: string; windows: UsageWindow[]; limitReached?: boolean }[]
}

/** Thrown with a message that is safe to print; it never quotes a response. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function windowOf(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== "object") return
  const row = value as Json
  const usedPercent = numberOr(row.used_percent)
  const windowSeconds = numberOr(row.limit_window_seconds)
  if (usedPercent === undefined || windowSeconds === undefined) return
  const resetAt = numberOr(row.reset_at)
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowSeconds,
    ...(resetAt !== undefined && resetAt > 0
      ? { resetsAt: resetAt * 1000 }
      : {}),
  }
}

function windowsOf(limit: unknown): UsageWindow[] {
  if (!limit || typeof limit !== "object") return []
  const row = limit as Json
  return [windowOf(row.primary_window), windowOf(row.secondary_window)].filter(
    (window): window is UsageWindow => Boolean(window)
  )
}

/**
 * Reads a usage response, Codex's `RateLimitStatusPayload` (codex-rs,
 * codex-backend-openapi-models): `plan_type`, `rate_limit` with a primary and
 * secondary window, `credits`, `additional_rate_limits`. Anything missing is
 * left out rather than guessed.
 */
export function parseUsage(raw: unknown): SubscriptionUsage {
  const row = (raw && typeof raw === "object" ? raw : {}) as Json
  const limit = (row.rate_limit ?? undefined) as Json | undefined
  const credits = row.credits as Json | undefined
  const reached = row.rate_limit_reached_type as Json | undefined
  return {
    ...(typeof row.plan_type === "string" ? { plan: row.plan_type } : {}),
    ...(typeof limit?.allowed === "boolean" ? { allowed: limit.allowed } : {}),
    ...(typeof limit?.limit_reached === "boolean"
      ? { limitReached: limit.limit_reached }
      : {}),
    ...(typeof reached?.type === "string" ? { reachedType: reached.type } : {}),
    windows: windowsOf(limit),
    ...(credits && typeof credits === "object"
      ? {
          credits: {
            hasCredits: credits.has_credits === true,
            unlimited: credits.unlimited === true,
            ...(typeof credits.balance === "string"
              ? { balance: credits.balance }
              : {}),
          },
        }
      : {}),
    additional: (Array.isArray(row.additional_rate_limits)
      ? (row.additional_rate_limits as Json[])
      : []
    )
      .filter((entry) => entry && typeof entry.limit_name === "string")
      .map((entry) => {
        const details = (entry.rate_limit ?? {}) as Json
        return {
          name: String(entry.limit_name),
          windows: windowsOf(details),
          ...(typeof details.limit_reached === "boolean"
            ? { limitReached: details.limit_reached }
            : {}),
        }
      }),
  }
}

/** The signed-in plan's current usage, from OpenAI. */
export async function fetchSubscriptionUsage(
  fetcher: typeof fetch = fetch
): Promise<SubscriptionUsage> {
  const login = await currentLogin(fetcher)
  let response: Response
  try {
    response = await fetcher(OPENAI_LOGIN.usage, {
      headers: {
        Authorization: `Bearer ${login.access}`,
        ...backendHeaders(login),
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new UsageError("Could not reach OpenAI to read the plan's usage.")
  }
  if (!response.ok)
    throw new UsageError(
      response.status === 401 || response.status === 403
        ? `OpenAI refused the usage request (HTTP ${response.status}). Run pnpm ai login --provider openai again.`
        : `OpenAI did not return the plan's usage (HTTP ${response.status}).`
    )
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new UsageError("OpenAI's usage answer was not JSON.")
  }
  return parseUsage(raw)
}
