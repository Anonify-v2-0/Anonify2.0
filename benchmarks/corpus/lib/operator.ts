import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

/**
 * The one real person a generation run is guaranteed to be near: whoever runs
 * it.
 *
 * Claude Code sends the signed-in account's email address to the model as
 * context even with `--system-prompt`, and in trials the model used it as a
 * character's address. An email is caught by the reserved-range check, but a
 * name derived from it ("nabeel.wasif" → "Nabeel Wasif") would not be. So the
 * script collects what identifies the operator, from the CLIs' own account
 * files, git and the OS, and rejects any document that mentions it.
 */

const run = promisify(execFile)

/** Parts too generic to reject a document for. */
const GENERIC = new Set([
  "claude",
  "codex",
  "noreply",
  "no-reply",
  "anthropic",
  "openai",
  "root",
  "user",
  "admin",
  "runner",
  "ubuntu",
  "node",
  "github",
  "users",
  "example",
  "mail",
  "gmail",
  "outlook",
  "hotmail",
  "yahoo",
  "icloud",
  "info",
])

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return null
  }
}

async function gitConfig(key: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["config", "--get", key])
    return stdout.trim() || null
  } catch {
    return null
  }
}

function jwtClaims(token: unknown): Record<string, unknown> {
  if (typeof token !== "string") return {}
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    )
  } catch {
    return {}
  }
}

/** Strings that identify the operator, from wherever they can be found. */
export async function operatorStrings(extra: string[] = []): Promise<string[]> {
  const found: (string | null | undefined)[] = [...extra]

  const claude = (await readJson(path.join(homedir(), ".claude.json"))) as {
    oauthAccount?: { emailAddress?: string; displayName?: string }
  } | null
  found.push(
    claude?.oauthAccount?.emailAddress,
    claude?.oauthAccount?.displayName
  )

  const codex = (await readJson(
    path.join(
      process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
      "auth.json"
    )
  )) as { tokens?: { id_token?: string } } | null
  const claims = jwtClaims(codex?.tokens?.id_token)
  found.push(
    claims.email as string | undefined,
    claims.name as string | undefined
  )

  found.push(await gitConfig("user.name"), await gitConfig("user.email"))
  try {
    found.push(userInfo().username)
  } catch {
    // No passwd entry in some containers.
  }
  found.push(process.env.USER, process.env.LOGNAME)
  found.push(...(process.env.CORPUS_DENY ?? "").split(","))

  return [
    ...new Set(
      found
        .map((value) => value?.trim())
        .filter((value): value is string => !!value)
    ),
  ]
}

/**
 * The strings to look for: each email whole, and every name-like part of
 * four letters or more, from names, usernames and email local parts.
 */
export function denyTokens(strings: string[]): string[] {
  const tokens = new Set<string>()
  for (const value of strings) {
    const lower = value.toLowerCase()
    const at = lower.indexOf("@")
    if (at > 0) tokens.add(lower)
    const source = at > 0 ? lower.slice(0, at) : lower
    for (const part of source.split(/[^\p{L}]+/u)) {
      if (part.length >= 4 && !GENERIC.has(part)) tokens.add(part)
    }
  }
  return [...tokens].sort()
}

/** The deny tokens that occur in `text` as whole words, ignoring case. */
export function findDenied(text: string, tokens: string[]): string[] {
  const lower = text.toLowerCase()
  return tokens.filter((token) => {
    let from = 0
    for (;;) {
      const at = lower.indexOf(token, from)
      if (at === -1) return false
      const before = lower[at - 1]
      const after = lower[at + token.length]
      const boundary = (ch: string | undefined) =>
        ch === undefined || !/[\p{L}\p{N}]/u.test(ch)
      if (boundary(before) && boundary(after)) return true
      from = at + 1
    }
  })
}

/** "nabeel" → "na****", so a rejection log does not repeat what it rejected. */
export function mask(token: string): string {
  return `${token.slice(0, 2)}${"*".repeat(Math.max(2, token.length - 2))}`
}
