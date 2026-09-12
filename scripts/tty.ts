/**
 * The bits of a terminal interface that are not the thing being asked.
 *
 * Colour, a spinner, a progress bar, and prompts that will not accept an answer
 * they cannot use. It lives apart from `scripts/setup.ts` because none of it is
 * about Anonify, and because the rule it exists to enforce is one rule: **a
 * prompt never silently reinterprets what you typed.** The old setup script
 * read `"3"` at a two-option menu and quietly gave you option one, which is the
 * shape of bug that ends with someone wondering why their instance is
 * configured for a service they never chose.
 *
 * Everything degrades. Piped output, `NO_COLOR`, `TERM=dumb` or a
 * non-interactive stdin each turn this into plain text and defaults, because a
 * setup script that hangs waiting for a keypress inside a Dockerfile is worse
 * than one that is dull.
 */

import { createInterface, type Interface } from "node:readline/promises"
import { Writable } from "node:stream"

import { formatByteSize, parseByteSize } from "@/lib/config/bytes"

// --- colour -----------------------------------------------------------------

/**
 * https://no-color.org — an explicit request, honoured whatever the terminal
 * says it can do. `FORCE_COLOR` is the other direction, for CI logs that render
 * ANSI perfectly well while reporting no TTY.
 */
export function colorEnabled(
  stream: NodeJS.WriteStream = process.stdout
): boolean {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== "0"
  if (process.env.TERM === "dumb") return false
  return Boolean(stream.isTTY)
}

let useColor = colorEnabled()

export function setColor(enabled: boolean): void {
  useColor = enabled
}

/** Written out rather than escaped, so no raw control byte lives in source. */
const ESC = String.fromCharCode(27)

function wrap(open: number, close: number) {
  return (value: string): string =>
    useColor ? `${ESC}[${open}m${value}${ESC}[${close}m` : value
}

export const paint = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
}

// --- layout -----------------------------------------------------------------

const WIDTH = 74

export function say(line = ""): void {
  process.stdout.write(`${line}\n`)
}

export function rule(): void {
  say(paint.gray("  " + "─".repeat(WIDTH)))
}

/** A numbered section header with a bar showing how far through you are. */
export function step(index: number, total: number, title: string): void {
  const filled = Math.round((index / total) * 24)
  const bar =
    paint.cyan("█".repeat(filled)) + paint.gray("░".repeat(24 - filled))

  say()
  say(
    `  ${paint.gray(`Step ${index} of ${total}`)}  ${bar}  ${paint.bold(title)}`
  )
  rule()
}

export function note(line: string): void {
  say(`  ${paint.gray(line)}`)
}

export function bullet(line: string): void {
  say(`    ${paint.gray("·")} ${line}`)
}

export function ok(line: string): void {
  say(`  ${paint.green("✓")} ${line}`)
}

export function warn(line: string): void {
  say(`  ${paint.yellow("!")} ${line}`)
}

export function fail(line: string): void {
  say(`  ${paint.red("✗")} ${line}`)
}

/**
 * A key and its value, aligned, with the value dimmed when it is only the
 * default. Reading a config back is the moment people notice a wrong answer,
 * so the two cases have to look different.
 */
export function setting(
  key: string,
  value: string,
  { defaulted = false }: { defaulted?: boolean } = {}
): void {
  const padded = key.padEnd(44)
  say(
    `    ${paint.gray(padded)} ${
      defaulted ? paint.gray(value) : paint.cyan(value)
    }`
  )
}

// --- the spinner ------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export type Spinner = {
  succeed(line?: string): void
  fail(line?: string): void
  stop(): void
}

/**
 * Shown only while something is genuinely happening.
 *
 * Nothing here sleeps to look busy: the spinner wraps the port probe and the
 * write-and-read-back, both of which can take a moment on a cold filesystem or
 * a machine with something already bound to 5432. A fake delay would be a lie
 * told to make a tool feel substantial, which is a strange thing to put in a
 * redaction tool.
 */
export function spin(label: string): Spinner {
  if (!process.stdout.isTTY || !useColor) {
    say(`  ${paint.gray("·")} ${label}`)
    return {
      succeed: (line) => line && ok(line),
      fail: (line) => line && fail(line),
      stop: () => {},
    }
  }

  let frame = 0
  process.stdout.write(`  ${paint.cyan(FRAMES[0])} ${label}`)

  const timer = setInterval(() => {
    frame = (frame + 1) % FRAMES.length
    process.stdout.write(`\r  ${paint.cyan(FRAMES[frame])} ${label}`)
  }, 80)
  // An interval that keeps the process alive is how a CLI ends up hanging
  // after its work is done.
  timer.unref()

  const clear = () => {
    clearInterval(timer)
    process.stdout.write(`\r${" ".repeat(label.length + 6)}\r`)
  }

  return {
    succeed: (line) => {
      clear()
      ok(line ?? label)
    },
    fail: (line) => {
      clear()
      fail(line ?? label)
    },
    stop: clear,
  }
}

// --- prompts ----------------------------------------------------------------

export type Choice<T> = {
  value: T
  label: string
  /** The lines under the label. Where the actual explaining happens. */
  detail?: string[]
  disabled?: string
}

/**
 * Questions, and the promise that an answer is either understood or asked
 * again.
 *
 * `interactive` is false when stdin is not a terminal or `--yes` was passed. In
 * that mode every question resolves to its default and says which default it
 * took, so a scripted run is readable afterwards rather than silent.
 */
export class Prompter {
  private readonly rl: Interface | null
  private muted = false

  constructor(readonly interactive: boolean) {
    this.rl = interactive
      ? createInterface({
          input: process.stdin,
          terminal: Boolean(process.stdin.isTTY),
          // A pasted credential must not be recalled and echoed by an arrow key
          // in the next ordinary prompt.
          historySize: 0,
          output: new Writable({
            write: (chunk, encoding, callback) => {
              if (!this.muted) process.stdout.write(chunk, encoding)
              callback()
            },
          }),
        })
      : null
  }

  close(): void {
    this.rl?.close()
  }

  private async read(question: string): Promise<string> {
    if (!this.rl) return ""
    return (await this.rl.question(question)).trim()
  }

  async secret(question: string, fallback = ""): Promise<string> {
    if (!this.rl) return fallback
    process.stdout.write(
      `  ${question}${fallback ? " [Enter keeps existing credential]" : ""}: `
    )
    this.muted = true
    try {
      return (await this.read("")) || fallback
    } finally {
      this.muted = false
      process.stdout.write("\n")
    }
  }

  /** Free text, with a default shown in brackets. */
  async ask(
    question: string,
    options: { fallback?: string; hint?: string } = {}
  ): Promise<string> {
    const fallback = options.fallback ?? ""

    if (!this.interactive) {
      this.echo(question, fallback || "(blank)")
      return fallback
    }

    if (options.hint) note(options.hint)
    const suffix = fallback ? paint.gray(` [${fallback}]`) : ""
    const answer = await this.read(`  ${question}${suffix}: `)
    return answer || fallback
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    if (!this.interactive) {
      this.echo(question, fallback ? "yes" : "no")
      return fallback
    }

    // Loops rather than treating anything unrecognised as "no". Someone typing
    // "yeah" meant yes, and reading it as no is the wrong way to be strict.
    for (;;) {
      const suffix = paint.gray(fallback ? " [Y/n]" : " [y/N]")
      const answer = (await this.read(`  ${question}${suffix}: `)).toLowerCase()

      if (!answer) return fallback
      if (["y", "yes"].includes(answer)) return true
      if (["n", "no"].includes(answer)) return false

      warn(`"${answer}" is not yes or no.`)
    }
  }

  /** A numbered menu. Nothing but a listed number is accepted. */
  async choose<T>(
    question: string,
    choices: Choice<T>[],
    fallbackIndex = 0
  ): Promise<T> {
    if (!choices[fallbackIndex] || choices[fallbackIndex].disabled) {
      fallbackIndex = choices.findIndex((choice) => !choice.disabled)
    }
    if (fallbackIndex < 0)
      throw new Error("No selectable choices are available")
    // A blank line after a choice separates it from its explanation. A list of
    // fifteen bare labels has no explanations to separate, and spacing them out
    // turns a menu that fits on screen into one that scrolls.
    const spaced = choices.some((choice) => (choice.detail ?? []).length > 0)

    say()
    for (const [index, choice] of choices.entries()) {
      const marker = index === fallbackIndex ? paint.cyan("›") : " "
      say(
        `  ${marker} ${paint.bold(`${index + 1}.`)} ${paint.bold(choice.label)}`
      )
      for (const line of choice.detail ?? []) say(`       ${paint.gray(line)}`)
      if (choice.disabled)
        say(`       ${paint.gray(`Unavailable: ${choice.disabled}`)}`)
      if (spaced) say()
    }
    if (!spaced) say()

    if (!this.interactive) {
      this.echo(question, choices[fallbackIndex].label)
      return choices[fallbackIndex].value
    }

    for (;;) {
      const answer = await this.read(
        `  ${question} ${paint.gray(`[1-${choices.length}, default ${fallbackIndex + 1}]`)}: `
      )
      if (!answer) return choices[fallbackIndex].value

      const picked = Number(answer)
      if (Number.isInteger(picked) && picked >= 1 && picked <= choices.length) {
        if (choices[picked - 1].disabled) {
          warn(choices[picked - 1].disabled!)
          continue
        }
        return choices[picked - 1].value
      }

      warn(`"${answer}" is not one of 1 to ${choices.length}.`)
    }
  }

  /**
   * A whole number, re-asked until it is one.
   *
   * `allowZero` is not decoration: a quota of zero means unlimited, and an
   * email parser limit of zero means a parser that refuses everything — which
   * is why `emlLimits()` throws on it rather than accepting it.
   */
  async askInteger(
    question: string,
    options: { fallback: number; allowZero?: boolean; unit?: string }
  ): Promise<number> {
    const { fallback, allowZero = false } = options

    if (!this.interactive) {
      this.echo(question, String(fallback))
      return fallback
    }

    for (;;) {
      const unit = options.unit ? paint.gray(` ${options.unit}`) : ""
      const answer = await this.read(
        `    ${question}${unit} ${paint.gray(`[${fallback}]`)}: `
      )
      if (!answer) return fallback

      if (!/^\d+$/.test(answer)) {
        warn(`  "${answer}" is not a whole number.`)
        continue
      }
      if (!allowZero && Number(answer) === 0) {
        warn("  Zero would refuse every document. Use a positive number.")
        continue
      }
      return Number(answer)
    }
  }

  /**
   * An amount of money, re-asked until it is one.
   *
   * Not `askInteger`, because a daily AI budget of $2.50 is an ordinary thing
   * to want and rounding somebody's budget to the nearest dollar without saying
   * so is the sort of quiet dishonesty this script exists to avoid. Zero is a
   * real answer here and means no cap.
   */
  async askAmount(
    question: string,
    options: { fallback: number; unit?: string }
  ): Promise<number> {
    const { fallback } = options

    if (!this.interactive) {
      this.echo(question, String(fallback))
      return fallback
    }

    for (;;) {
      const unit = options.unit ? paint.gray(` ${options.unit}`) : ""
      const answer = await this.read(
        `    ${question}${unit} ${paint.gray(`[${fallback}]`)}: `
      )
      if (!answer) return fallback

      const value = Number(answer.replace(/^\$/, ""))
      if (!Number.isFinite(value) || value < 0) {
        warn(`  "${answer}" is not an amount in dollars.`)
        continue
      }
      return value
    }
  }

  /**
   * A size, in the units people actually write sizes in.
   *
   * Not `askInteger`, because the honest answer to "how much decoded text may
   * one message hold" is 16 MB and the byte count for it is 16777216. Asking
   * for the second is asking somebody to do a power-of-two multiplication at a
   * prompt, and the way that goes wrong is not a syntax error — it is a
   * plausible number off by a factor of a thousand, accepted, written to
   * `.env` and in force until a file somebody expected to work is refused.
   *
   * A plain number is still bytes, so anything already in a `.env` reads back
   * unchanged and anyone who thinks in bytes can keep doing so.
   */
  async askSize(
    question: string,
    options: { fallback: number; unit?: string }
  ): Promise<string> {
    const shown = formatByteSize(options.fallback)

    if (!this.interactive) {
      this.echo(question, shown)
      return shown
    }

    for (;;) {
      const unit = options.unit ? paint.gray(` ${options.unit}`) : ""
      const answer = await this.read(
        `    ${question}${unit} ${paint.gray(`[${shown}]`)}: `
      )
      if (!answer) return shown

      const bytes = parseByteSize(answer)
      if (bytes === null) {
        warn(`  "${answer}" is not a size. Try 32MB, 512KB or 1GB.`)
        continue
      }
      // Echoed back in canonical form, so what lands in `.env` is what this
      // script would have printed as a default — `32MB`, never `32 mb`.
      return formatByteSize(bytes)
    }
  }

  /** `requests/seconds`, the shape `ANONIFY_RATE_LIMIT_*` is parsed as. */
  async askRate(
    question: string,
    options: { fallback: string }
  ): Promise<string> {
    if (!this.interactive) {
      this.echo(question, options.fallback)
      return options.fallback
    }

    for (;;) {
      const answer = await this.read(
        `    ${question} ${paint.gray(`[${options.fallback}]`)}: `
      )
      if (!answer) return options.fallback

      const match = /^(\d+)\/(\d+)$/.exec(answer)
      if (!match || Number(match[1]) === 0 || Number(match[2]) === 0) {
        warn(`  "${answer}" should look like 100/60 — requests per seconds.`)
        continue
      }
      return answer
    }
  }

  private echo(question: string, value: string): void {
    note(`${question} → ${value}`)
  }
}
