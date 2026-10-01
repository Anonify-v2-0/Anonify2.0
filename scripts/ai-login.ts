/**
 * The pieces of `pnpm ai login` that are worth testing on their own: the
 * loopback callback and the decision to open a browser. `scripts/ai.ts` runs
 * `main()` on import, so it cannot be tested; this is why the split exists.
 * The sign-in itself lives here too, so `pnpm bench:models` can sign in to
 * its own store without going through `pnpm ai`.
 */

import { spawn } from "node:child_process"
import { createServer, type ServerResponse } from "node:http"

import {
  authorizeUrl,
  codeFromRedirect,
  exchangeCode,
  LoginError,
  newPkce,
  OPENAI_LOGIN,
  type StoredLogin,
} from "@/lib/ai/providers/subscription"

import { note, Prompter, say, spin, warn } from "./tty"

export type CallbackServer = {
  /** The authorization code, once the browser comes back with one. */
  code: Promise<string>
  port: number
  close(): void
}

function page(response: ServerResponse, status: number, message: string) {
  // Every message here is one of ours, and none carries a value from the
  // request; escaping is for the day somebody changes that.
  const text = message.replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`
  )
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // The address bar still holds the code; do not hand it to anything else.
    "Referrer-Policy": "no-referrer",
  })
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Anonify sign-in</title><body style="font:16px system-ui;margin:3rem auto;max-width:32rem"><p>${text}</p></body>`
  )
}

/**
 * Listens on the loopback interface for the provider's redirect.
 *
 * Only 127.0.0.1, never every interface: the request carries an authorization
 * code. A request with the wrong `state` is answered and ignored rather than
 * ending the sign-in, so a stray or forged visit cannot cancel it; an explicit
 * refusal from the provider does end it. Resolves null when the port is taken,
 * and the caller falls back to pasting the redirect.
 */
export function startCallbackServer(
  state: string,
  port: number = OPENAI_LOGIN.port
): Promise<CallbackServer | null> {
  let resolve!: (code: string) => void
  let reject!: (error: Error) => void
  const code = new Promise<string>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  // Settled only by the caller's race; an unobserved rejection is not a crash.
  code.catch(() => {})

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (
      request.method !== "GET" ||
      url.pathname !== OPENAI_LOGIN.callbackPath
    ) {
      response.writeHead(404).end()
      return
    }
    try {
      const value = codeFromRedirect(url.search, state)
      page(
        response,
        200,
        "Signed in. You can close this tab and return to the terminal."
      )
      resolve(value)
    } catch (error) {
      const message =
        error instanceof LoginError ? error.message : "The sign-in failed."
      page(response, 400, message)
      if (url.searchParams.has("error")) reject(new LoginError(message))
    }
  })

  return new Promise((done) => {
    server.once("error", () => done(null))
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      done({
        code,
        port: typeof address === "object" && address ? address.port : port,
        close: () => {
          server.close()
          server.closeAllConnections()
        },
      })
    })
  })
}

/**
 * Whether this looks like a machine with a browser to open. Over SSH, or on
 * Linux with no display, the link is printed and the paste fallback is the
 * way in.
 */
export function canOpenBrowser(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false
  if (platform === "linux") return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
  return platform === "darwin" || platform === "win32"
}

/** Best effort, and silent when it fails: the link is on screen either way. */
export function openBrowser(url: string): void {
  // Never through a shell: the URL is full of `&`, which cmd.exe and sh both
  // read as the end of a command.
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  } catch {
    /* printed already */
  }
}

/**
 * Signs in with a ChatGPT subscription and returns the token, unsaved: where
 * it is kept is the caller's business. The browser comes back to a loopback
 * server; in a terminal, the address it ends on can be pasted instead, which
 * is the way in from a machine with no browser.
 *
 * It opens its own prompt, so a caller holding one lends the terminal first
 * (`Prompter.handOff`).
 */
export async function signIn(options: {
  browser: boolean
  interactive: boolean
}): Promise<StoredLogin> {
  const { interactive } = options
  const pkce = newPkce()
  const url = authorizeUrl(pkce)
  const server = await startCallbackServer(pkce.state)
  if (!server && !interactive)
    throw new Error(
      `Port ${OPENAI_LOGIN.port} is in use and there is no terminal to paste into. Free the port, or run this in a terminal.`
    )

  say(`  Open this address in a browser signed in to ChatGPT:`)
  say()
  say(`  ${url}`)
  say()
  if (server && options.browser && canOpenBrowser()) openBrowser(url)
  if (interactive)
    note(
      server
        ? "The browser returns here by itself. Without a browser on this machine, sign in elsewhere; the last page will fail to load a localhost address. Copy that whole address and paste it below."
        : `Port ${OPENAI_LOGIN.port} is in use, so paste the address the browser ends on (it will fail to load).`
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
        return codeFromRedirect(text, pkce.state)
      } catch (error) {
        if (!(error instanceof LoginError)) throw error
        warn(error.message)
      }
    }
  }
  const timeout = new Promise<string>((_, reject) => {
    const timer = setTimeout(
      () => reject(new LoginError("No sign-in within ten minutes.")),
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
  try {
    return await exchangeCode(code, pkce.verifier)
  } finally {
    exchanging.stop()
  }
}
