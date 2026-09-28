/**
 * The live view of a generator run: finished documents scroll by, and below
 * them a region redrawn a dozen times a second holds a progress bar, what each
 * worker is writing and for how long, and why drafts are being rejected.
 *
 * Plain ANSI, no dependency. When stdout is not a terminal (CI, a pipe, a log
 * file) nothing is redrawn and each event is one plain line, so a run's output
 * can still be read back afterwards. NO_COLOR and FORCE_COLOR are honoured.
 */

const ESC = "\x1b["

type Stream = NodeJS.WriteStream

export type Palette = ReturnType<typeof palette>

function colorDepth(stream: Stream): number {
  if (process.env.NO_COLOR) return 1
  if (process.env.FORCE_COLOR === "0") return 1
  if (process.env.FORCE_COLOR) return Math.max(4, stream.getColorDepth?.() ?? 4)
  return stream.isTTY ? (stream.getColorDepth?.() ?? 4) : 1
}

export function palette(stream: Stream = process.stdout) {
  const depth = colorDepth(stream)
  const on = depth > 1
  const sgr = (open: string, close: string) => (text: string) =>
    on ? `${ESC}${open}m${text}${ESC}${close}m` : text
  const rgb = (r: number, g: number, b: number) => (text: string) =>
    !on
      ? text
      : depth >= 24
        ? `${ESC}38;2;${r};${g};${b}m${text}${ESC}39m`
        : `${ESC}${nearest16(r, g, b)}m${text}${ESC}39m`
  return {
    enabled: on,
    truecolor: depth >= 24,
    bold: sgr("1", "22"),
    dim: sgr("2", "22"),
    italic: sgr("3", "23"),
    red: sgr("31", "39"),
    green: sgr("32", "39"),
    yellow: sgr("33", "39"),
    blue: sgr("34", "39"),
    magenta: sgr("35", "39"),
    cyan: sgr("36", "39"),
    gray: sgr("90", "39"),
    rgb,
  }
}

function nearest16(r: number, g: number, b: number): number {
  const bright = Math.max(r, g, b) > 170
  const bit = (v: number) => (v > 110 ? 1 : 0)
  const code = bit(r) | (bit(g) << 1) | (bit(b) << 2)
  return (bright ? 90 : 30) + code
}

/** Visible width, ignoring escape sequences. Every glyph used here is one column. */
export function visible(text: string): number {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length
}

/** Cut a styled line to `width` columns, keeping escape sequences intact. */
export function fit(text: string, width: number): string {
  if (visible(text) <= width) return text
  let out = ""
  let columns = 0
  const tokens = text.match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/g) ?? []
  for (const token of tokens) {
    if (token.startsWith("\x1b")) {
      out += token
    } else if (columns < width - 1) {
      out += token
      columns++
    }
  }
  return text.includes(ESC) ? `${out}…${ESC}0m` : `${out}…`
}

export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visible(text)))
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0
    ? `${h}h${String(m).padStart(2, "0")}m`
    : `${m}:${String(s).padStart(2, "0")}`
}

/** A rounded box around `lines`, for the banner and the summary. */
export function box(
  lines: string[],
  c: Palette,
  title = "",
  width = process.stdout.columns ?? 80
): string {
  const inner = Math.min(
    Math.max(visible(title) + 4, ...lines.map(visible)),
    Math.max(20, width - 4)
  )
  const edge = c.cyan
  const top = title
    ? `${edge("╭─")} ${c.bold(title)} ${edge(`${"─".repeat(Math.max(0, inner - visible(title) - 1))}╮`)}`
    : edge(`╭${"─".repeat(inner + 2)}╮`)
  const body = lines.map(
    (line) => `${edge("│")} ${pad(fit(line, inner), inner)} ${edge("│")}`
  )
  return [top, ...body, edge(`╰${"─".repeat(inner + 2)}╯`)].join("\n")
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** From cyan through blue to violet, as the bar fills. */
const GRADIENT: Array<[number, number, number]> = [
  [34, 211, 238],
  [59, 130, 246],
  [139, 92, 246],
  [217, 70, 239],
]

function gradientAt(t: number): [number, number, number] {
  const scaled = Math.min(0.9999, Math.max(0, t)) * (GRADIENT.length - 1)
  const i = Math.floor(scaled)
  const f = scaled - i
  const [a, b] = [GRADIENT[i], GRADIENT[i + 1]]
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [
    number,
    number,
    number,
  ]
}

/**
 * A progress bar whose filled part is a gradient with a highlight sweeping
 * across it, so a run that is waiting on a slow model still visibly moves.
 * With no frame it is still, for output that is printed once.
 */
export function progressBar(
  fraction: number,
  width: number,
  frame: number | null,
  c: Palette
): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  const sweep = frame === null || filled === 0 ? -9 : frame % (filled + 12)
  let out = ""
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      const glint = Math.abs(i - sweep) <= 1
      const [r, g, b] = gradientAt(i / Math.max(1, width - 1))
      out += glint
        ? c.rgb(
            Math.min(255, r + 90),
            Math.min(255, g + 90),
            Math.min(255, b + 90)
          )("━")
        : c.truecolor
          ? c.rgb(r, g, b)("━")
          : c.cyan("━")
    } else if (i === filled) {
      out += c.gray("╺")
    } else {
      out += c.gray("━")
    }
  }
  return out
}

/** Short, countable names for the rejection reasons build.ts gives. */
export function reasonKind(reason: string): string {
  const kinds: Array<[RegExp, string]> = [
    [/^unmarked repeat/, "unmarked repeat"],
    [/required category .* missing/, "missing category"],
    [/is never named/, "cast member unnamed"],
    [/outside the reserved ranges/, "unreserved value"],
    [/unknown placeholder/, "unknown placeholder"],
    [/words is outside/, "wrong length"],
    [/marked up as/, "placeholder mislabelled"],
    [/malformed|markup without|unclosed|nested/, "malformed markup"],
    [/operator/, "operator mentioned"],
    [/negative/, "hard negative missing"],
    [/density "none"/, "labels in a none document"],
    [/JSON|schema/, "bad JSON"],
    [/timed out|timeout/i, "timed out"],
  ]
  for (const [pattern, kind] of kinds) if (pattern.test(reason)) return kind
  return reason.split(/\s+/).slice(0, 3).join(" ")
}

type Slot = {
  id: string
  detail: string
  attempt: number
  cached: boolean
  startedAt: number
  attemptStartedAt: number
  phase: number
} | null

export type DashboardOptions = {
  total: number
  concurrency: number
  attempts: number
  stream?: Stream
}

export class Dashboard {
  readonly c: Palette
  readonly live: boolean
  private readonly stream: Stream
  private readonly total: number
  private readonly attempts: number
  private readonly slots: Slot[]
  private readonly startedAt = Date.now()
  private readonly reasons = new Map<string, number>()
  private height = 0
  private frame = 0
  private timer: NodeJS.Timeout | null = null
  private note = ""

  written = 0
  failed = 0
  firstTry = 0
  calls = 0
  retries = 0
  cost = 0
  /** Time spent on documents that finished, for the per-document average. */
  private finishedMs = 0

  constructor(options: DashboardOptions) {
    this.stream = options.stream ?? process.stdout
    this.c = palette(this.stream)
    this.live = Boolean(this.stream.isTTY) && !process.env.CI
    this.total = options.total
    this.attempts = options.attempts
    this.slots = Array.from({ length: options.concurrency }, () => null)
  }

  get done(): number {
    return this.written + this.failed
  }

  start() {
    if (!this.live || this.timer) return
    this.stream.write(`${ESC}?25l`)
    const restore = () => this.stream.write(`${ESC}?25h`)
    process.once("exit", restore)
    this.timer = setInterval(() => {
      this.frame++
      this.render()
    }, 80)
    this.timer.unref()
    this.render()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.live) {
      this.clear()
      this.stream.write(`${ESC}?25h`)
    }
  }

  /** A permanent line, printed above the live region. */
  log(line: string) {
    if (!this.live) {
      this.stream.write(
        `${this.c.enabled ? line : line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")}\n`
      )
      return
    }
    const width = (this.stream.columns ?? 100) - 1
    this.clear()
    this.stream.write(`${fit(line, width)}\n`)
    this.render()
  }

  /** A line under the progress bar, until replaced. */
  setNote(note: string) {
    this.note = note
    this.render()
  }

  begin(slot: number, id: string, detail: string) {
    const now = Date.now()
    this.slots[slot] = {
      id,
      detail,
      attempt: 1,
      cached: false,
      startedAt: now,
      attemptStartedAt: now,
      phase: slot * 3,
    }
    this.render()
  }

  attempt(slot: number, attempt: number, cached: boolean) {
    const current = this.slots[slot]
    if (!current) return
    current.attempt = attempt
    current.cached = cached
    current.attemptStartedAt = Date.now()
    if (!cached) this.calls++
    this.render()
  }

  rejected(reasons: string[], final: boolean) {
    for (const kind of new Set(reasons.map(reasonKind)))
      this.reasons.set(kind, (this.reasons.get(kind) ?? 0) + 1)
    if (!final) this.retries++
  }

  finish(slot: number, outcome: "written" | "rejected", attempt?: number) {
    const current = this.slots[slot]
    if (current) this.finishedMs += Date.now() - current.startedAt
    if (outcome === "written") {
      this.written++
      if (attempt === 1) this.firstTry++
    } else {
      this.failed++
    }
    this.slots[slot] = null
    this.render()
  }

  elapsed(slot: number): number {
    const current = this.slots[slot]
    return current ? Date.now() - current.startedAt : 0
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  topReasons(n = 3): Array<[string, number]> {
    return [...this.reasons].sort((a, b) => b[1] - a[1]).slice(0, n)
  }

  /** Remaining time, from the rate documents have been finishing at. */
  eta(): number | null {
    if (this.done === 0) return null
    const rate = this.done / this.elapsedMs
    return (this.total - this.done) / rate
  }

  private clear() {
    if (this.height > 0) this.stream.write(`${ESC}${this.height}F${ESC}0J`)
    this.height = 0
  }

  private render() {
    if (!this.live) return
    const lines = this.lines()
    const width = (this.stream.columns ?? 100) - 1
    const up = this.height > 0 ? `${ESC}${this.height}F` : ""
    this.stream.write(
      `${up}${lines.map((line) => `${fit(line, width)}${ESC}0K`).join("\n")}\n${ESC}0J`
    )
    this.height = lines.length
  }

  private lines(): string[] {
    const { c } = this
    const width = (this.stream.columns ?? 100) - 1
    const fraction = this.total === 0 ? 1 : this.done / this.total
    const counter = `${this.done}/${this.total}`
    const percent = `${Math.floor(fraction * 100)}%`.padStart(4)
    const barWidth = Math.max(10, Math.min(60, width - counter.length - 12))
    const lines = [
      "",
      `  ${progressBar(fraction, barWidth, this.frame, c)} ${c.bold(percent)}  ${c.dim(counter)}`,
    ]

    const stats = [
      c.green(`✓ ${this.written} written`),
      this.failed ? c.red(`✗ ${this.failed} gave up`) : c.dim("✗ 0 gave up"),
      this.retries
        ? c.yellow(`↻ ${this.retries} retries`)
        : c.dim("↻ 0 retries"),
      c.dim(`${this.calls} model calls`),
    ]
    if (this.done > 0)
      stats.push(
        c.dim(`first try ${Math.round((100 * this.firstTry) / this.done)}%`)
      )
    lines.push(`  ${stats.join(c.gray("  ·  "))}`, "")

    this.slots.forEach((slot, i) => {
      const n = c.gray(String(i + 1).padStart(2))
      if (!slot) {
        lines.push(`  ${c.gray("·")} ${n}  ${c.gray("idle")}`)
        return
      }
      const spinnerColor =
        slot.attempt === 1
          ? c.cyan
          : slot.attempt < this.attempts
            ? c.yellow
            : c.red
      const spinner = spinnerColor(
        SPINNER[(this.frame + slot.phase) % SPINNER.length]
      )
      const attempt = pad(
        slot.attempt === 1
          ? c.dim("attempt 1")
          : spinnerColor(`attempt ${slot.attempt}/${this.attempts}`),
        `attempt ${this.attempts}/${this.attempts}`.length
      )
      const clock = duration(Date.now() - slot.startedAt).padStart(5)
      const what = slot.cached
        ? c.dim("checking a cached draft")
        : c.dim("writing")
      lines.push(
        `  ${spinner} ${n}  ${c.bold(slot.id)}  ${slot.detail}  ${attempt}  ${c.gray(clock)}  ${what}`
      )
    })

    const eta = this.eta()
    const perDoc = this.done > 0 ? duration(this.finishedMs / this.done) : "—"
    const rate =
      this.done > 0 ? (this.done / (this.elapsedMs / 60_000)).toFixed(1) : "—"
    lines.push(
      "",
      `  ${c.dim("elapsed")} ${duration(this.elapsedMs)}  ${c.dim("eta")} ${eta === null ? "—" : `~${duration(eta)}`}  ${c.dim("per document")} ${perDoc}  ${c.dim("docs/min")} ${rate}${this.cost ? `  ${c.dim("cost")} $${this.cost.toFixed(2)}` : ""}`
    )
    const top = this.topReasons()
    if (top.length > 0)
      lines.push(
        `  ${c.dim("rejected for")} ${top.map(([kind, count]) => `${c.yellow(kind)} ${c.gray(String(count))}`).join(c.gray(" · "))}`
      )
    lines.push(
      `  ${c.gray(this.note || "ctrl+c stops cleanly; every response is cached, so a rerun resumes")}`
    )
    return lines
  }
}
