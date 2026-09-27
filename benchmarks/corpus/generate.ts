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
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { int } from "./lib/args"
import { createBackend, DEFAULT_MODELS, type Backend } from "./lib/backends"
import { buildDocument } from "./lib/build"
import { buildManifest } from "./lib/manifest"
import { denyTokens, operatorStrings } from "./lib/operator"
import {
  PROMPT_VERSION,
  RESPONSE_SCHEMA,
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
    force: values.force,
    rebuild: values.rebuild,
    dryRun: values["dry-run"],
    manifestOnly: values.manifest,
  }
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

async function generateOne(
  spec: DocumentSpec,
  backend: Backend,
  options: Options,
  signal: AbortSignal
): Promise<Outcome> {
  const user = userPrompt(spec)
  let costUsd = 0
  let lastReasons: string[] = []

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

    if (!cached) {
      try {
        const completion = await backend.complete({
          system: SYSTEM_PROMPT,
          user,
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
  const short = Object.entries(manifest.targets).filter(
    ([, target]) => !target.met
  )
  console.log(
    `\nmanifest.json: ${manifest.documents.total} documents, ${manifest.spans.total} spans, ${manifest.corpus}`
  )
  if (manifest.documents.total > 0 && short.length > 0) {
    console.log(
      `Below target in the test split: ${short.map(([category, t]) => `${category} ${t.test}/${t.target}`).join(", ")}`
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
  })

  const pending: DocumentSpec[] = []
  for (const spec of specs) {
    const file = documentPath(options.out, spec)
    if (await exists(file)) {
      if (!options.force) continue
      if (isReviewed(await readJson(file))) {
        console.log(
          `· ${spec.id}  reviewed by a person; --force leaves it (delete the file to regenerate it)`
        )
        continue
      }
    }
    pending.push(spec)
  }
  const queue = pending.slice(0, options.limit)
  console.log(
    `Rejecting any document that mentions the operator: ${options.denyTokens.length} identifying strings from your CLI accounts, git, the OS and --deny.`
  )
  console.log(
    `${specs.length - pending.length} of ${specs.length} documents already exist; generating ${queue.length} with ${backend.name} (${backend.model}), prompt v${PROMPT_VERSION}, seed ${options.seed}.\n`
  )

  const controller = new AbortController()
  process.once("SIGINT", () => {
    console.log(
      "\nInterrupted: finishing nothing new. Cached responses are kept; run again to resume."
    )
    controller.abort()
  })

  let written = 0
  let failed = 0
  let cost = 0
  let fatal: string | null = null
  let next = 0

  const worker = async () => {
    while (next < queue.length && !controller.signal.aborted && !fatal) {
      const spec = queue[next++]
      const outcome = await generateOne(
        spec,
        backend,
        options,
        controller.signal
      )
      cost += outcome.costUsd
      if (outcome.status === "written") {
        written++
        console.log(
          `✓ ${describe(spec)}  ${outcome.spans} spans, attempt ${outcome.attempt}`
        )
      } else if (outcome.status === "rejected") {
        failed++
        if (!controller.signal.aborted) {
          console.log(
            `✗ ${describe(spec)}  rejected ${options.attempts}×: ${outcome.reasons.slice(0, 3).join("; ")}`
          )
        }
      } else {
        fatal = outcome.message
        controller.abort()
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, queue.length) }, worker)
  )

  console.log(
    `\n${written} written, ${failed} rejected after ${options.attempts} attempts${cost ? `, $${cost.toFixed(2)} reported by the CLI` : ""}. Rejection reasons: ${path.relative(process.cwd(), path.join(cacheDir(options.out), "rejects.jsonl"))}`
  )
  await writeManifest(options.out)
  if (fatal) {
    console.error(`\nStopped: ${fatal}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
