import { readFile, stat } from "node:fs/promises"
import path from "node:path"

/**
 * How to start a CLI by name, on Windows as well.
 *
 * `spawn("codex", …)` without a shell finds only `.exe` and `.com` files on
 * Windows. npm, pnpm and yarn install a Node CLI there as a `codex.cmd`
 * wrapper, so a CLI installed that way reads as "not found". Running the
 * wrapper through `cmd.exe` is not a general answer either: Claude Code is
 * handed the multi-line system prompt as an argument, and `cmd.exe` cannot
 * carry a newline in an argument.
 *
 * So the command is looked up the way Windows looks it up, along PATH and
 * PATHEXT. An executable is started directly. A package manager's wrapper
 * names the Node script it runs, and that script is started with this Node,
 * which passes every argument through untouched. Anything else falls back to
 * `cmd.exe`, but only with arguments it can carry exactly.
 */

export type Launch = {
  file: string
  args: string[]
  /** Added to the child's environment. */
  env?: Record<string, string>
  /** For `cmd.exe`: the command line is already quoted. */
  verbatim?: boolean
}

export type Environment = Record<string, string | undefined>

export type Host = {
  platform: NodeJS.Platform
  env: Environment
  /** The Node that runs a package manager's wrapper script. */
  execPath: string
  isFile(file: string): Promise<boolean>
  readText(file: string): Promise<string>
}

const host: Host = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  isFile: (file) =>
    stat(file).then(
      (stats) => stats.isFile(),
      () => false
    ),
  readText: (file) => readFile(file, "utf8"),
}

export class CommandNotFoundError extends Error {
  constructor(command: string) {
    super(`\`${command}\` was not found on PATH`)
  }
}

/** Case-insensitively: Windows is, and PATH and PATHEXT come in any case. */
function envValue(env: Environment, name: string): string | undefined {
  const key = Object.keys(env).find(
    (each) => each.toUpperCase() === name.toUpperCase()
  )
  return key === undefined ? undefined : env[key]
}

/** Where Windows would find `command`, or null. */
export async function findOnPath(
  command: string,
  from: Host = host
): Promise<string | null> {
  const extensions = (envValue(from.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  const given = path.extname(command).toLowerCase()
  const names = extensions.includes(given)
    ? [command]
    : extensions.map((extension) => command + extension)
  const directories =
    command.includes("/") || command.includes("\\")
      ? [""]
      : (envValue(from.env, "PATH") ?? "").split(";").filter(Boolean)
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory ? path.join(directory, name) : name
      if (await from.isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * The Node script a package manager's `.cmd` wrapper runs, and the NODE_PATH
 * it sets, if the wrapper is one. npm and yarn (cmd-shim) and pnpm
 * (@zkochan/cmd-shim) all name the script relative to the wrapper's own
 * directory, as `"%~dp0\…\cli.js"` or `"%dp0%\…\cli.js"`.
 */
export function readNodeWrapper(
  wrapper: string,
  text: string
): { script: string; nodePath?: string } | null {
  const target = /"%(?:~dp0|dp0)%?\\?([^"%]+\.[cm]?js)"/i.exec(text)
  if (!target) return null
  const script = path.join(
    path.dirname(wrapper),
    ...target[1].split(/[\\/]+/).filter(Boolean)
  )
  // pnpm points NODE_PATH at its virtual store so a global CLI resolves its
  // dependencies; only the literal value, not one built from %NODE_PATH%.
  const nodePath = /@?SET\s+"NODE_PATH=([^"%]+)"/i.exec(text)?.[1]
  return { script, nodePath }
}

/**
 * Quoted for `cmd.exe /s /c "…"`. Inside double quotes cmd.exe takes `&`,
 * `|`, `<`, `>` and `^` literally, but it still expands `%`, and nothing
 * carries a quote or a line break, so those are refused rather than mangled.
 */
function cmdQuote(argument: string): string | null {
  return /["%\r\n]/.test(argument) ? null : `"${argument}"`
}

/** How to start `command` with `args` so that it receives them exactly. */
export async function resolveLaunch(
  command: string,
  args: string[],
  from: Host = host
): Promise<Launch> {
  if (from.platform !== "win32") return { file: command, args }

  const found = await findOnPath(command, from)
  if (!found) throw new CommandNotFoundError(command)
  const extension = path.extname(found).toLowerCase()
  if (extension !== ".cmd" && extension !== ".bat") return { file: found, args }

  const wrapper = readNodeWrapper(found, await from.readText(found))
  if (wrapper && (await from.isFile(wrapper.script))) {
    const inherited = envValue(from.env, "NODE_PATH")
    return {
      file: from.execPath,
      args: [wrapper.script, ...args],
      env: wrapper.nodePath
        ? {
            NODE_PATH: inherited
              ? `${wrapper.nodePath};${inherited}`
              : wrapper.nodePath,
          }
        : undefined,
    }
  }

  const quoted = [found, ...args].map(cmdQuote)
  if (quoted.some((each) => each === null)) {
    throw new Error(
      `\`${command}\` is ${found}, a batch file Anonify cannot read as a Node CLI, ` +
        `and its arguments cannot pass through cmd.exe intact. Put the CLI's ` +
        `.exe on PATH, or use --backend command.`
    )
  }
  return {
    file: envValue(from.env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${quoted.join(" ")}"`],
    verbatim: true,
  }
}
