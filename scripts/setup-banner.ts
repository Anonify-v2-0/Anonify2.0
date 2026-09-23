/**
 * The first thing `pnpm setup` prints: a small redacted document, the version,
 * and one honest sentence about what is about to happen.
 *
 * The drawing is only for a person at a terminal. Piped into a log or run with
 * TERM=dumb it becomes two plain lines, because box-drawing characters in a CI
 * log are noise and on a dumb terminal they are mojibake. `--no-color` keeps
 * the drawing and drops the colour — it is legible in one colour by design.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { paint } from "./tty"

/** Read beside this script, not from wherever setup happened to be run. */
export function setupVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")
    ) as { version?: unknown }
    if (typeof packageJson.version === "string") return packageJson.version
  } catch {
    /* Fall through to what the package manager says. */
  }
  return process.env.npm_package_version ?? "development"
}

// Text lines and redaction bars on a page. Each row is padded to the same
// width below, so the frame stays square whatever is drawn inside it.
const PAGE = ["──── ───────", "─── ████ ───", "────── ███──", "█████ ──────"]
const INNER = Math.max(...PAGE.map((row) => row.length)) + 2

function pageRow(row: string): string {
  const cells = ` ${row}`.padEnd(INNER)
  const drawn = [...cells]
    .map((cell) => (cell === "█" ? cell : paint.gray(cell)))
    .join("")
  return `${paint.gray("│")}${drawn}${paint.gray("│")}`
}

export function bannerLines(options: {
  version: string
  fancy: boolean
}): string[] {
  const title = `${paint.bold(paint.cyan("Anonify"))} ${paint.gray("setup")}`
  const version = paint.gray(`v${options.version} · Node ${process.version}`)
  // Not "nothing leaves your machine": with a hosted AI provider, documents
  // do, and a redaction tool is the last place to overstate privacy.
  const welcome = "Welcome. This writes .env for your instance."
  const promise =
    "It calls only the AI provider you pick, and runs nothing else until you ask."

  if (!options.fancy) {
    return [
      `  ${title} ${version}`,
      `  ${paint.gray(welcome)}`,
      `  ${paint.gray(promise)}`,
    ]
  }

  const side = [
    title,
    version,
    "",
    welcome,
    "It calls only the AI provider you pick, and runs",
    "nothing else until you ask.",
  ]
  const art = [
    paint.gray(`┌${"─".repeat(INNER)}┐`),
    ...PAGE.map(pageRow),
    paint.gray(`└${"─".repeat(INNER)}┘`),
  ]
  return art.map((row, index) =>
    side[index] ? `  ${row}   ${side[index]}` : `  ${row}`
  )
}

export function fancyTerminal(
  stream: NodeJS.WriteStream = process.stdout
): boolean {
  return Boolean(stream.isTTY) && process.env.TERM !== "dumb"
}
