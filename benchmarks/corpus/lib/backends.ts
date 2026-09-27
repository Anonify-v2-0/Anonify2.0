import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * The model, reached through a command-line agent the operator is already
 * signed in to. No API key is read here: Claude Code and Codex bring their
 * own credentials, whether that is an API key or a subscription login.
 *
 * Each call runs in an empty temporary directory, so the CLI picks up no
 * project instructions (CLAUDE.md, AGENTS.md) and has nothing to read or edit.
 * Tools are turned off where the CLI allows it.
 */

export type Completion = {
  text: string
  /** What the CLI reported, when it reports anything. */
  costUsd?: number
  usage?: Record<string, unknown>
}

export type Backend = {
  name: string
  model: string
  complete(request: {
    system: string
    user: string
    schema: object
    signal?: AbortSignal
  }): Promise<Completion>
}

export type BackendOptions = {
  backend: string
  model?: string
  /** For the `command` backend: a shell command that reads the prompt on stdin. */
  command?: string
  /** Extra arguments passed through to the CLI, verbatim. */
  extraArgs: string[]
  timeoutMs: number
  /**
   * Claude's extended-thinking budget. Explicit rather than inherited: a
   * shell inside a Claude Code session exports its own MAX_THINKING_TOKENS,
   * and on this task thinking is ~90% of the output tokens.
   */
  thinkingTokens: number
}

export const DEFAULT_MODELS: Record<string, string> = {
  claude: "claude-haiku-4-5",
  codex: "gpt-5-mini",
  command: "unknown",
}

type RunResult = { stdout: string; stderr: string; code: number | null }

function run(
  command: string,
  args: string[],
  options: {
    input: string
    cwd: string
    timeoutMs: number
    env?: Record<string, string>
    shell?: boolean
    signal?: AbortSignal
  }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      // Not waiting for "close": that waits for the pipes, and a process the
      // shell started can hold them open after the shell itself has gone.
      child.stdout.destroy()
      child.stderr.destroy()
      reject(
        new Error(
          `\`${command}\` timed out after ${Math.round(options.timeoutMs / 1000)}s`
        )
      )
    }, options.timeoutMs)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`\`${command}\` was not found on PATH`)
          : error
      )
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
    // A CLI that exits without reading its input (signed out, an unknown
    // flag, a --command that is not installed) closes the pipe first. The
    // exit code reaches "close" above; the EPIPE must not crash the run.
    child.stdin.on("error", () => {})
    child.stdin.end(options.input)
  })
}

async function withScratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "anonify-corpus-"))
  try {
    return await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function failure(name: string, result: RunResult): Error {
  const detail = (result.stderr || result.stdout)
    .trim()
    .split("\n")
    .slice(-5)
    .join("\n")
  return new Error(
    `${name} exited with ${result.code ?? "a signal"}${detail ? `:\n${detail}` : ""}`
  )
}

/**
 * Claude Code in print mode: `claude -p`, JSON output, the corpus system prompt
 * in place of Claude Code's own, no tools, and the response schema enforced.
 */
function claudeBackend(options: BackendOptions): Backend {
  const model = options.model ?? DEFAULT_MODELS.claude
  return {
    name: "claude",
    model,
    complete: ({ system, user, schema, signal }) =>
      withScratch(async (cwd) => {
        const args = [
          "-p",
          "--output-format",
          "json",
          "--model",
          model,
          "--system-prompt",
          system,
          "--tools",
          "",
          "--json-schema",
          JSON.stringify(schema),
          "--no-session-persistence",
          ...options.extraArgs,
        ]
        const result = await run("claude", args, {
          input: user,
          cwd,
          timeoutMs: options.timeoutMs,
          signal,
          env: {
            // Long documents need more than the default output budget.
            CLAUDE_CODE_MAX_OUTPUT_TOKENS:
              process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? "64000",
            MAX_THINKING_TOKENS: String(options.thinkingTokens),
          },
        })
        if (result.code !== 0 && !result.stdout.trim())
          throw failure("claude", result)
        let envelope: {
          is_error?: boolean
          result?: string
          structured_output?: unknown
          total_cost_usd?: number
          usage?: Record<string, unknown>
          subtype?: string
        }
        try {
          envelope = JSON.parse(result.stdout)
        } catch {
          throw failure("claude", result)
        }
        if (envelope.is_error) {
          throw new Error(
            `claude reported an error (${envelope.subtype ?? "unknown"}): ${String(envelope.result ?? "").slice(0, 300)}`
          )
        }
        const text =
          envelope.structured_output !== undefined
            ? JSON.stringify(envelope.structured_output)
            : String(envelope.result ?? "")
        return { text, costUsd: envelope.total_cost_usd, usage: envelope.usage }
      }),
  }
}

/**
 * Codex non-interactively: `codex exec`, read-only sandbox, nothing persisted,
 * the response schema enforced, and the final message written to a file.
 * Codex has no system-prompt flag for exec, so the system prompt leads the
 * message.
 */
function codexBackend(options: BackendOptions): Backend {
  const model = options.model ?? DEFAULT_MODELS.codex
  return {
    name: "codex",
    model,
    complete: ({ system, user, schema, signal }) =>
      withScratch(async (cwd) => {
        const schemaFile = path.join(cwd, "schema.json")
        const outputFile = path.join(cwd, "last-message.txt")
        await writeFile(schemaFile, JSON.stringify(schema))
        const args = [
          "exec",
          "--model",
          model,
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--ephemeral",
          "--color",
          "never",
          "--output-schema",
          schemaFile,
          "--output-last-message",
          outputFile,
          "--cd",
          cwd,
          ...options.extraArgs,
          "-",
        ]
        const result = await run("codex", args, {
          input: `${system}\n\n---\n\n${user}`,
          cwd,
          timeoutMs: options.timeoutMs,
          signal,
        })
        if (result.code !== 0) throw failure("codex", result)
        return { text: await readFile(outputFile, "utf8") }
      }),
  }
}

/**
 * Anything else: a shell command that reads the prompt on stdin and writes the
 * JSON response to stdout. The system prompt, user prompt and schema are also
 * in the environment and in files, for tools that take them separately:
 *
 *   --backend command --command 'llm -m gpt-4o-mini -s "$CORPUS_SYSTEM"'
 *   --backend command --command 'ollama run qwen3:8b'
 */
function commandBackend(options: BackendOptions): Backend {
  if (!options.command)
    throw new Error("--backend command needs --command '<shell command>'")
  const command = options.command
  return {
    name: "command",
    model: options.model ?? DEFAULT_MODELS.command,
    complete: ({ system, user, schema, signal }) =>
      withScratch(async (cwd) => {
        const files = {
          CORPUS_SYSTEM_FILE: path.join(cwd, "system.txt"),
          CORPUS_USER_FILE: path.join(cwd, "user.txt"),
          CORPUS_SCHEMA_FILE: path.join(cwd, "schema.json"),
        }
        await writeFile(files.CORPUS_SYSTEM_FILE, system)
        await writeFile(files.CORPUS_USER_FILE, user)
        await writeFile(files.CORPUS_SCHEMA_FILE, JSON.stringify(schema))
        const result = await run(command, [], {
          input: `${system}\n\n---\n\n${user}`,
          cwd,
          shell: true,
          timeoutMs: options.timeoutMs,
          signal,
          env: { ...files, CORPUS_SYSTEM: system, CORPUS_USER: user },
        })
        // The shell's "command not found". It fails the same way for every
        // document, so it is worded the way a missing claude or codex is,
        // which stops the run instead of retrying each document.
        if (result.code === 127) {
          throw new Error(
            `${failure(command, result).message}\n(the command was not found on PATH)`
          )
        }
        if (result.code !== 0) throw failure(command, result)
        return { text: result.stdout }
      }),
  }
}

export function createBackend(options: BackendOptions): Backend {
  switch (options.backend) {
    case "claude":
      return claudeBackend(options)
    case "codex":
      return codexBackend(options)
    case "command":
      return commandBackend(options)
    default:
      throw new Error(
        `unknown backend "${options.backend}"; use claude, codex or command`
      )
  }
}
