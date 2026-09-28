/**
 * Generates the synthetic, labelled PII corpus described in issue #57.
 *
 *   pnpm corpus:generate                          # all 600, via Claude Code
 *   pnpm corpus:generate --backend codex          # via Codex
 *   pnpm corpus:generate --limit 5                # the first five missing documents
 *   pnpm corpus:generate --ids syn-v1-0042        # one document
 *   pnpm corpus:generate --dry-run --ids syn-v1-0042   # print its prompt, call nothing
 *   pnpm corpus:generate --rebuild                # re-derive labels from cached responses
 *
 * A cheap model writes each document with its personal data marked up inline;
 * this script fills the placeholders from reserved ranges, strips the markup,
 * records exact offsets, and rejects anything malformed or anything that could
 * be real. See benchmarks/README.md for the label format and the checks.
 *
 * Seeded and resumable. A document that already exists on disk is skipped, and
 * every model response is cached under benchmarks/corpus/.cache before it is
 * checked, so an interrupted run loses at most the calls in flight and a fix
 * to the checks can be applied with --rebuild without paying for a token.
 *
 * A retry is told why the previous draft was rejected, and the longest
 * documents are started first so the run does not end waiting on one.
 *
 * The corpus is committed as synthetic-v1.tar.gz (see lib/archive.ts): it is
 * unpacked before anything is read and packed again after anything is written.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { packAfterRun, syncBeforeRun } from "./lib/archive"
import { int } from "./lib/args"
import { createBackend, DEFAULT_MODELS, type Backend } from "./lib/backends"
import { buildDocument } from "./lib/build"
import { buildManifest, type Manifest } from "./lib/manifest"
import { denyTokens, operatorStrings } from "./lib/operator"
import {
  PROMPT_VERSION,
  RESPONSE_SCHEMA,
  retryNote,
  SYSTEM_PROMPT,
  userPrompt,
} from "./lib/prompt"
import {
  documentPath,
  generatorInfo,
  isReviewed,
  readJson,
  rebuild,
  writeDocument,
  type CachedResponse,
} from "./lib/rebuild"
import { CORPUS_SIZE, sampleSpecs } from "./lib/spec"
import {
  box,
  Dashboard,
  duration,
  pad,
  palette,
  progressBar,
  type Palette,
} from "./lib/tui"
import type { DocumentSpec } from "./lib/types"

const HERE = import.meta.dirname

const USAGE = `Usage: pnpm corpus:generate [options]

  --backend <name>      claude (default), codex, or command
  --model <id>          model for the backend (claude: ${DEFAULT_MODELS.claude}, codex: ${DEFAULT_MODELS.codex})
  --command <shell>     for --backend command: reads the prompt on stdin, prints JSON
  --backend-arg <arg>   extra argument for the CLI; repeatable
  --deny <text>         a name or email that must not appear; repeatable. Your
                        CLI account, git identity and OS user are added
                        automatically, and CORPUS_DENY is read too
  --seed <n>            corpus seed (default 57)
  --size <n>            documents in the corpus (default ${CORPUS_SIZE})
  --out <dir>           output directory (default benchmarks/corpus/synthetic-v1)
  --ids <a,b,...>       only these documents
  --limit <n>           stop after this many new documents
  --concurrency <n>     requests in flight (default 4)
  --attempts <n>        tries per document before giving up (default 3)
  --thinking <tokens>   Claude's extended-thinking budget (default 0: off)
  --effort <level>      Codex's reasoning effort: minimal, low (default),
                        medium, high, or config for ~/.codex/config.toml's
  --timeout <seconds>   per request (default 900)
  --force               regenerate documents that already exist, except those
                        reviewed by a person
  --rebuild             re-derive every document from cached responses, and
                        remove those no cached response passes; no model calls
  --dry-run             print the specs (and, with --ids, the prompts); no model calls
  --manifest            only rewrite manifest.json
`

type Options = {
  backend: string
  model?: string
  command?: string
  backendArgs: string[]
  deny: string[]
  /** Filled in by main() from `deny` and the operator's accounts. */
  denyTokens: string[]
  seed: number
  size: number
  out: string
  ids?: string[]
  limit: number
  concurrency: number
  attempts: number
  timeoutMs: number
  thinkingTokens: number
  effort: string
  force: boolean
  rebuild: boolean
  dryRun: boolean
  manifestOnly: boolean
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      backend: { type: "string", default: "claude" },
      model: { type: "string" },
      command: { type: "string" },
      "backend-arg": { type: "string", multiple: true, default: [] },
      deny: { type: "string", multiple: true, default: [] },
      seed: { type: "string", default: "57" },
      size: { type: "string", default: String(CORPUS_SIZE) },
      out: { type: "string", default: path.join(HERE, "synthetic-v1") },
      ids: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "4" },
      attempts: { type: "string", default: "3" },
      timeout: { type: "string", default: "900" },
      thinking: { type: "string", default: "0" },
      effort: { type: "string", default: "low" },
      force: { type: "boolean", default: false },
      rebuild: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      manifest: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  return {
    backend: values.backend,
    model: values.model,
    command: values.command,
    backendArgs: values["backend-arg"],
    deny: values.deny,
    denyTokens: [],
    seed: int("seed", values.seed),
    size: int("size", values.size),
    out: path.resolve(values.out),
    ids: values.ids
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    limit: values.limit === undefined ? Infinity : int("limit", values.limit),
    concurrency: Math.max(1, int("concurrency", values.concurrency)),
    attempts: Math.max(1, int("attempts", values.attempts)),
    timeoutMs: int("timeout", values.timeout) * 1000,
    thinkingTokens: int("thinking", values.thinking),
    effort: effortLevel(values.effort),
    force: values.force,
    rebuild: values.rebuild,
    dryRun: values["dry-run"],
    manifestOnly: values.manifest,
  }
}

function effortLevel(value: string): string {
  if (!/^[a-z]+$/.test(value)) {
    throw new Error(
      `--effort must be a level such as low or high, or config, not ${JSON.stringify(value)}`
    )
  }
  return value
}

// --- paths and cache --------------------------------------------------------

function cacheDir(out: string): string {
  return path.join(HERE, ".cache", path.basename(out))
}

function responsePath(out: string, id: string, attempt: number): string {
  return path.join(cacheDir(out), "responses", `${id}.${attempt}.json`)
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

async function logReject(out: string, entry: object) {
  await mkdir(cacheDir(out), { recursive: true })
  await appendFile(
    path.join(cacheDir(out), "rejects.jsonl"),
    `${JSON.stringify(entry)}\n`
  )
}

// --- one document -----------------------------------------------------------

type Outcome =
  | { status: "written"; attempt: number; spans: number; costUsd: number }
  | { status: "rejected"; costUsd: number; reasons: string[] }
  | { status: "error"; costUsd: number; message: string }

/** What generateOne tells the display as it goes. */
type Progress = {
  attempt(attempt: number, cached: boolean): void
  rejected(attempt: number, reasons: string[]): void
}

async function generateOne(
  spec: DocumentSpec,
  backend: Backend,
  options: Options,
  signal: AbortSignal,
  progress: Progress
): Promise<Outcome> {
  let costUsd = 0
  let lastReasons: string[] = []
  // Why the checks rejected the previous draft; a failed call is not a draft.
  let feedback: string[] = []

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (signal.aborted) break
    const cacheFile = responsePath(options.out, spec.id, attempt)
    let cached = await readJson<CachedResponse>(cacheFile)
    if (
      cached &&
      (cached.promptVersion !== PROMPT_VERSION ||
        cached.backend !== backend.name ||
        cached.model !== backend.model ||
        cached.seed !== options.seed)
    ) {
      cached = null
    }

    progress.attempt(attempt, cached !== null)
    if (!cached) {
      try {
        const completion = await backend.complete({
          system: SYSTEM_PROMPT,
          user: userPrompt(spec) + (feedback.length ? retryNote(feedback) : ""),
          schema: RESPONSE_SCHEMA,
          signal,
        })
        cached = {
          id: spec.id,
          attempt,
          backend: backend.name,
          model: backend.model,
          promptVersion: PROMPT_VERSION,
          seed: options.seed,
          text: completion.text,
          ...(feedback.length ? { feedback } : {}),
          costUsd: completion.costUsd,
          usage: completion.usage,
          createdAt: new Date().toISOString(),
        }
        costUsd += completion.costUsd ?? 0
        await mkdir(path.dirname(cacheFile), { recursive: true })
        await writeFile(cacheFile, `${JSON.stringify(cached, null, 2)}\n`)
      } catch (error) {
        if (signal.aborted) break
        const message = (error as Error).message
        // A CLI that is missing or signed out fails the same way every time.
        if (
          /not found on PATH|log ?in|logged in|authenticat|api key/i.test(
            message
          )
        ) {
          return { status: "error", costUsd, message }
        }
        await logReject(options.out, { id: spec.id, attempt, error: message })
        lastReasons = [message]
        progress.rejected(attempt, lastReasons)
        continue
      }
    }

    const result = buildDocument(spec, cached.text, generatorInfo(cached), {
      deny: options.denyTokens,
    })
    if (result.ok) {
      await writeDocument(options.out, spec, result.document)
      return {
        status: "written",
        attempt,
        spans: result.document.spans.length,
        costUsd,
      }
    }
    lastReasons = result.reasons
    feedback = result.reasons
    progress.rejected(attempt, lastReasons)
    await logReject(options.out, {
      id: spec.id,
      attempt,
      reasons: result.reasons,
    })
  }
  return { status: "rejected", costUsd, reasons: lastReasons }
}

// --- reporting --------------------------------------------------------------

function describe(spec: DocumentSpec): string {
  return `${spec.id}  ${spec.split.padEnd(4)} ${spec.locale}  ${spec.length.padEnd(6)} ${spec.density.padEnd(6)} ${spec.docType}`
}

/** The same, in colour, without the id. */
function detail(spec: DocumentSpec, c: Palette): string {
  const density = {
    none: c.gray,
    low: c.green,
    medium: c.yellow,
    high: c.red,
  }[spec.density]
  return [
    c.dim(spec.split.padEnd(4)),
    c.cyan(spec.locale),
    spec.length.padEnd(6),
    density(spec.density.padEnd(6)),
    c.magenta(pad(spec.docType, 16)),
  ].join(" ")
}

function ordinal(attempt: number): string {
  return attempt === 1
    ? "first try"
    : attempt === 2
      ? "second try"
      : attempt === 3
        ? "third try"
        : `try ${attempt}`
}

/** `unmarked repeat of "Priya" at 402 (+2 more)`, cut to fit on a line. */
function firstReason(reasons: string[]): string {
  const [first = "", ...rest] = reasons
  const head = first.length > 90 ? `${first.slice(0, 89)}…` : first
  return rest.length ? `${head} (+${rest.length} more)` : head
}

function printDistribution(specs: DocumentSpec[]) {
  const tally = (key: (spec: DocumentSpec) => string) => {
    const counts = new Map<string, number>()
    for (const spec of specs)
      counts.set(key(spec), (counts.get(key(spec)) ?? 0) + 1)
    return [...counts]
      .sort()
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")
  }
  console.log(`split:    ${tally((s) => s.split)}`)
  console.log(`length:   ${tally((s) => s.length)}`)
  console.log(`density:  ${tally((s) => s.density)}`)
  console.log(`locale:   ${tally((s) => s.locale)}`)
  console.log(`docType:  ${tally((s) => s.docType)}`)
  const include = new Map<string, number>()
  for (const spec of specs.filter((s) => s.split === "test")) {
    for (const category of spec.mustInclude)
      include.set(category, (include.get(category) ?? 0) + 1)
  }
  console.log(
    `required in test documents: ${[...include]
      .sort()
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`
  )
}

async function writeManifest(out: string) {
  const manifest = await buildManifest(out)
  await mkdir(out, { recursive: true })
  await writeFile(
    path.join(out, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  const c = palette()
  console.log(
    `\n${c.bold("manifest.json")}  ${manifest.documents.total} documents · ${manifest.spans.total} spans · ${c.dim(manifest.corpus)}`
  )
  if (manifest.documents.total > 0) printTargets(manifest)
  await packAfterRun(out)
}

/** How far each category is from what #59 needs in the test split. */
function printTargets(manifest: Manifest) {
  const c = palette()
  console.log(c.dim("\n  test split against its targets"))
  for (const [category, target] of Object.entries(manifest.targets)) {
    const fraction = target.test / target.target
    const count = `${target.test}/${target.target}`.padStart(9)
    console.log(
      `  ${category.padEnd(14)} ${progressBar(fraction, 24, null, c)} ${target.met ? c.green(`${count} ✓`) : c.yellow(`${count}  ${Math.round(fraction * 100)}%`)}`
    )
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const allSpecs = sampleSpecs(options.seed, options.size)
  let specs = allSpecs
  if (options.ids) {
    const wanted = new Set(options.ids)
    specs = allSpecs.filter((spec) => wanted.has(spec.id))
    const unknown = options.ids.filter(
      (id) => !allSpecs.some((spec) => spec.id === id)
    )
    if (unknown.length)
      throw new Error(`no such document: ${unknown.join(", ")}`)
  }

  if (!options.dryRun) await syncBeforeRun(options.out)
  if (options.manifestOnly) return writeManifest(options.out)

  options.denyTokens = denyTokens(await operatorStrings(options.deny))

  if (options.dryRun) {
    printDistribution(allSpecs)
    console.log("")
    for (const spec of specs.slice(0, options.ids ? specs.length : 20))
      console.log(describe(spec))
    if (options.ids) {
      for (const spec of specs)
        console.log(`\n--- ${spec.id} ---\n${userPrompt(spec)}`)
    } else if (specs.length > 20) {
      console.log(`… and ${specs.length - 20} more`)
    }
    return
  }

  if (options.rebuild) {
    const summary = await rebuild(specs, {
      out: options.out,
      responses: path.join(cacheDir(options.out), "responses"),
      seed: options.seed,
      deny: options.denyTokens,
    })
    console.log(
      `\nRebuilt ${summary.written} from cache. No acceptable response for ${summary.rejected} (${summary.removed} removed from disk). Kept as they are: ${summary.reviewed} reviewed by a person, ${summary.uncached} with no cached response.`
    )
    await writeManifest(options.out)
    if (summary.failing.length > 0) {
      console.error(
        `\n${summary.failing.length} kept document${summary.failing.length === 1 ? " fails" : "s fail"} the current checks and need${summary.failing.length === 1 ? "s" : ""} a person to fix or delete: ${summary.failing.join(", ")}`
      )
      process.exitCode = 1
    }
    return
  }

  const backend = createBackend({
    backend: options.backend,
    model: options.model,
    command: options.command,
    extraArgs: options.backendArgs,
    timeoutMs: options.timeoutMs,
    thinkingTokens: options.thinkingTokens,
    effort: options.effort,
  })

  const c = palette()
  const pending: DocumentSpec[] = []
  for (const spec of specs) {
    const file = documentPath(options.out, spec)
    if (await exists(file)) {
      if (!options.force) continue
      if (isReviewed(await readJson(file))) {
        console.log(
          `${c.gray("·")} ${spec.id}  reviewed by a person; --force leaves it (delete the file to regenerate it)`
        )
        continue
      }
    }
    pending.push(spec)
  }
  // Longest first: a long document started last is what a run ends waiting on.
  const longestFirst = { long: 0, medium: 1, short: 2 }
  const queue = pending
    .slice(0, options.limit)
    .sort((a, b) => longestFirst[a.length] - longestFirst[b.length])

  const effort =
    backend.name === "codex"
      ? options.effort === "config"
        ? ", effort from config"
        : `, effort ${options.effort}`
      : backend.name === "claude" && options.thinkingTokens
        ? `, thinking ${options.thinkingTokens}`
        : ""
  const dot = c.gray("·")
  console.log(
    box(
      [
        `${c.bold(path.basename(options.out))}  ${dot}  ${backend.name} ${c.cyan(backend.model)}${c.dim(effort)}  ${dot}  prompt v${PROMPT_VERSION}  ${dot}  seed ${options.seed}`,
        `${c.green(String(specs.length - pending.length))} of ${specs.length} on disk  ${dot}  ${c.bold(String(queue.length))} to write  ${dot}  ${options.concurrency} at a time, up to ${options.attempts} attempts each`,
        c.dim(
          `Rejecting any document that mentions the operator: ${options.denyTokens.length} identifying strings from your CLI accounts, git, the OS and --deny.`
        ),
      ],
      c,
      "Anonify corpus generator"
    )
  )

  const dashboard = new Dashboard({
    total: queue.length,
    concurrency: Math.min(options.concurrency, queue.length),
    attempts: options.attempts,
  })

  const controller = new AbortController()
  process.once("SIGINT", () => {
    dashboard.log(
      c.yellow(
        "Interrupted: stopping the calls in flight. Cached responses are kept; run again to resume."
      )
    )
    dashboard.setNote("stopping… (ctrl+c again to quit at once)")
    controller.abort()
  })

  let fatal: string | null = null
  let next = 0
  if (queue.length > 0) dashboard.start()

  const worker = async (slot: number) => {
    while (next < queue.length && !controller.signal.aborted && !fatal) {
      const spec = queue[next++]
      dashboard.begin(slot, spec.id, detail(spec, c))
      const outcome = await generateOne(
        spec,
        backend,
        options,
        controller.signal,
        {
          attempt: (attempt, cached) =>
            dashboard.attempt(slot, attempt, cached),
          rejected: (attempt, reasons) => {
            const final = attempt >= options.attempts
            dashboard.rejected(reasons, final)
            if (!final && !controller.signal.aborted)
              dashboard.log(
                `${c.yellow("↻")} ${c.dim(spec.id)}  ${c.dim(`attempt ${attempt} rejected:`)} ${c.yellow(firstReason(reasons))}`
              )
          },
        }
      )
      dashboard.cost += outcome.costUsd
      const took = duration(dashboard.elapsed(slot))
      if (outcome.status === "written") {
        dashboard.log(
          `${c.green("✓")} ${c.bold(spec.id)}  ${detail(spec, c)}  ${c.green(`${outcome.spans} spans`)} ${dot} ${outcome.attempt === 1 ? c.dim(ordinal(1)) : c.yellow(ordinal(outcome.attempt))} ${dot} ${c.gray(took)}`
        )
        dashboard.finish(slot, "written", outcome.attempt)
      } else if (outcome.status === "rejected" && !controller.signal.aborted) {
        dashboard.log(
          `${c.red("✗")} ${c.bold(spec.id)}  ${detail(spec, c)}  ${c.red(`gave up after ${options.attempts}:`)} ${c.dim(firstReason(outcome.reasons))}`
        )
        dashboard.finish(slot, "rejected")
      } else if (outcome.status === "error") {
        fatal = outcome.message
        controller.abort()
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, queue.length) },
      (_, slot) => worker(slot)
    )
  )
  dashboard.stop()

  const rejects = path.relative(
    process.cwd(),
    path.join(cacheDir(options.out), "rejects.jsonl")
  )
  const reasons = dashboard.topReasons(5)
  const perDocument = dashboard.done
    ? `, one document every ${duration(dashboard.elapsedMs / dashboard.done)}`
    : ""
  console.log(
    `\n${box(
      [
        `${c.green(`✓ ${dashboard.written} written`)}   ${dashboard.failed ? c.red(`✗ ${dashboard.failed} gave up`) : c.dim("✗ 0 gave up")}   ${c.dim(`${queue.length - dashboard.done} not reached`)}`,
        `${dashboard.calls} model calls in ${duration(dashboard.elapsedMs)}${perDocument}${dashboard.cost ? `, $${dashboard.cost.toFixed(2)} reported by the CLI` : ""}`,
        ...(reasons.length
          ? [
              `${c.dim("rejected for")} ${reasons.map(([kind, count]) => `${c.yellow(kind)} ${count}`).join(c.gray(" · "))}`,
            ]
          : []),
        c.dim(`every reason: ${rejects}`),
        ...(dashboard.failed || queue.length === 0
          ? [
              c.dim(
                `a document that gave up is retried by a rerun with more attempts: --attempts ${options.attempts + 2}`
              ),
            ]
          : []),
      ],
      c,
      "Run finished"
    )}`
  )
  await writeManifest(options.out)
  if (fatal) {
    console.error(`\n${c.red("Stopped:")} ${fatal}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
