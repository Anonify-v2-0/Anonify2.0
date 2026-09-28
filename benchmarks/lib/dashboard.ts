import {
  box,
  duration,
  fit,
  pad,
  palette,
  progressBar,
  type Palette,
} from "../corpus/lib/tui"

/**
 * The live view of a model benchmark, in the style of the corpus generator's:
 * finished documents scroll by with their own recall and cost, and below them
 * a region redrawn a dozen times a second holds the progress bar, what each
 * worker is analysing and at which stage, the tokens and dollars spent so far,
 * and the running quality.
 *
 * Plain ANSI, no dependency. When stdout is not a terminal (CI, a pipe, a log
 * file) nothing is redrawn and each event is one plain line.
 */

const ESC = "\x1b["
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type Stream = NodeJS.WriteStream

type Slot = {
  id: string
  detail: string
  stage: string
  startedAt: number
  inputTokens: number
  outputTokens: number
  calls: number
  phase: number
} | null

export type DashboardOptions = {
  /** What is running, for the heading: "claude-haiku-4.5 · deterministic-first". */
  title: string
  total: number
  concurrency: number
  /** USD per million tokens, for a running cost. */
  rates: { inputPerMillion: number; outputPerMillion: number } | null
  stream?: Stream
}

export class BenchDashboard {
  readonly c: Palette
  readonly live: boolean
  private readonly stream: Stream
  private readonly slots: Slot[]
  private readonly bySlot = new Map<string, number>()
  private readonly startedAt = Date.now()
  private height = 0
  private frame = 0
  private timer: NodeJS.Timeout | null = null
  private note = ""
  private finishedMs = 0

  done = 0
  failed = 0
  degraded = 0
  calls = 0
  inputTokens = 0
  outputTokens = 0
  labels = 0
  covered = 0
  detections = 0
  correct = 0

  constructor(private readonly options: DashboardOptions) {
    this.stream = options.stream ?? process.stdout
    this.c = palette(this.stream)
    this.live = Boolean(this.stream.isTTY) && !process.env.CI
    this.slots = Array.from({ length: options.concurrency }, () => null)
  }

  get cost(): number | null {
    const rates = this.options.rates
    if (!rates) return null
    return (
      (this.inputTokens / 1e6) * rates.inputPerMillion +
      (this.outputTokens / 1e6) * rates.outputPerMillion
    )
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  start() {
    if (!this.live || this.timer) return
    this.stream.write(`${ESC}?25l`)
    process.once("exit", () => this.stream.write(`${ESC}?25h`))
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
    this.clear()
    this.stream.write(`${fit(line, (this.stream.columns ?? 100) - 1)}\n`)
    this.render()
  }

  setNote(note: string) {
    this.note = note
    this.render()
  }

  begin(slot: number, id: string, detail: string) {
    this.slots[slot] = {
      id,
      detail,
      stage: "starting",
      startedAt: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      phase: slot * 3,
    }
    this.bySlot.set(id, slot)
  }

  stage(slot: number, stage: string) {
    const current = this.slots[slot]
    if (current) current.stage = stage
  }

  /** One model call, as the usage ledger records it. */
  call(
    documentId: string,
    task: string,
    inputTokens: number,
    outputTokens: number
  ) {
    this.calls++
    this.inputTokens += inputTokens
    this.outputTokens += outputTokens
    const slot = this.bySlot.get(documentId)
    const current = slot === undefined ? null : this.slots[slot]
    if (current && current.id === documentId) {
      current.calls++
      current.inputTokens += inputTokens
      current.outputTokens += outputTokens
      current.stage = task
    }
  }

  finish(
    slot: number,
    outcome: {
      failed?: boolean
      degraded?: boolean
      labels?: number
      covered?: number
      detections?: number
      correct?: number
    }
  ) {
    const current = this.slots[slot]
    if (current) {
      this.finishedMs += Date.now() - current.startedAt
      this.bySlot.delete(current.id)
    }
    this.slots[slot] = null
    this.done++
    if (outcome.failed) this.failed++
    if (outcome.degraded) this.degraded++
    this.labels += outcome.labels ?? 0
    this.covered += outcome.covered ?? 0
    this.detections += outcome.detections ?? 0
    this.correct += outcome.correct ?? 0
  }

  /** Remaining time, from the rate documents have been finishing at. */
  eta(): number | null {
    if (this.done === 0) return null
    return ((this.options.total - this.done) * this.elapsedMs) / this.done
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
    const total = this.options.total
    const fraction = total === 0 ? 1 : this.done / total
    const counter = `${this.done}/${total}`
    const percent = `${Math.floor(fraction * 100)}%`.padStart(4)
    const barWidth = Math.max(10, Math.min(60, width - counter.length - 12))
    const lines = [
      "",
      `  ${c.bold(this.options.title)}`,
      `  ${progressBar(fraction, barWidth, this.frame, c)} ${c.bold(percent)}  ${c.dim(counter)}`,
    ]

    const stats = [
      c.green(`✓ ${this.done - this.failed} analysed`),
      this.failed ? c.red(`✗ ${this.failed} refused`) : c.dim("✗ 0 refused"),
      this.degraded
        ? c.yellow(`⚠ ${this.degraded} cut short`)
        : c.dim("⚠ 0 cut short"),
      c.dim(`${this.calls} model calls`),
    ]
    lines.push(`  ${stats.join(c.gray("  ·  "))}`, "")

    this.slots.forEach((slot, i) => {
      const n = c.gray(String(i + 1).padStart(2))
      if (!slot) {
        lines.push(`  ${c.gray("·")} ${n}  ${c.gray("idle")}`)
        return
      }
      const spinner = c.cyan(
        SPINNER[(this.frame + slot.phase) % SPINNER.length]
      )
      const clock = duration(Date.now() - slot.startedAt).padStart(5)
      const tokens = slot.calls
        ? c.dim(
            `${slot.calls} call${slot.calls === 1 ? "" : "s"} · ${compact(slot.inputTokens + slot.outputTokens)} tok`
          )
        : c.dim("—")
      lines.push(
        `  ${spinner} ${n}  ${c.bold(slot.id)}  ${pad(slot.detail, 26)}  ${pad(c.magenta(slot.stage), 10)}  ${c.gray(clock)}  ${tokens}`
      )
    })

    const eta = this.eta()
    const minutes = this.elapsedMs / 60_000
    const rate = this.done > 0 ? (this.done / minutes).toFixed(1) : "—"
    const cost = this.cost
    lines.push(
      "",
      `  ${c.dim("elapsed")} ${duration(this.elapsedMs)}  ${c.dim("eta")} ${eta === null ? "—" : `~${duration(eta)}`}  ${c.dim("docs/min")} ${rate}  ${c.dim("tokens")} ${compact(this.inputTokens)} in · ${compact(this.outputTokens)} out${cost === null ? "" : `  ${c.dim("cost")} $${cost.toFixed(cost < 1 ? 4 : 2)}`}`
    )
    if (this.labels > 0) {
      const recall = this.covered / this.labels
      const precision = this.detections ? this.correct / this.detections : null
      lines.push(
        `  ${c.dim("recall so far")} ${progressBar(recall, 16, null, c)} ${c.bold(pct(recall))}   ${c.dim("precision")} ${precision === null ? "—" : progressBar(precision, 16, null, c)} ${precision === null ? "" : c.bold(pct(precision))}`
      )
    }
    lines.push(
      `  ${c.gray(this.note || "ctrl+c stops after the documents in flight; every finished document is kept, so a rerun resumes")}`
    )
    return lines
  }
}

export function compact(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`
  if (count >= 1e4) return `${Math.round(count / 1e3)}k`
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`
  return String(count)
}

export function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`
}

export { box }
