import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { buildDocument, type GeneratorInfo } from "./build"
import { findDenied, mask } from "./operator"
import type { DocumentSpec, LabelledDocument } from "./types"
import { checkDocument } from "./verify"

/**
 * `--rebuild`: the corpus re-derived from cached model responses after a fix
 * to the checks, without calling a model. Afterwards every document on disk
 * is one the current checks accept, or one that was kept on purpose and is
 * named if it no longer passes.
 */

/** One model response, as generate.ts caches it before checking it. */
export type CachedResponse = {
  id: string
  attempt: number
  backend: string
  model: string
  promptVersion: string
  seed: number
  text: string
  costUsd?: number
  usage?: Record<string, unknown>
  createdAt: string
}

export function documentPath(out: string, spec: DocumentSpec): string {
  return path.join(out, spec.split, `${spec.id}.json`)
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return null
  }
}

export async function writeDocument(
  out: string,
  spec: DocumentSpec,
  document: object
) {
  const file = documentPath(out, spec)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`)
}

export function generatorInfo(cached: CachedResponse): GeneratorInfo {
  return {
    backend: cached.backend,
    model: cached.model,
    promptVersion: cached.promptVersion,
    seed: cached.seed,
    attempt: cached.attempt,
    reviewedByHuman: false,
  }
}

/**
 * Whether a person has settled this document's labels. Neither `--rebuild`
 * nor `--force` writes over one: the cached response it came from does not
 * have their corrections.
 */
export function isReviewed(document: unknown): boolean {
  return (
    (document as LabelledDocument | null)?.generator?.reviewedByHuman === true
  )
}

/**
 * The checks a document kept as it is must still pass: those `corpus:check`
 * holds every committed file to, and the operator's identity, which
 * `corpus:check` cannot know.
 */
export function checkKept(
  document: LabelledDocument,
  deny: string[]
): string[] {
  const problems = checkDocument(document)
  const names = (document.entities ?? []).map((entity) => entity.name)
  for (const token of findDenied(
    [document.title, document.text, ...names].join("\n"),
    deny
  )) {
    problems.push(`mentions the operator's identity (${mask(token)})`)
  }
  return problems
}

export type RebuildSummary = {
  /** Re-derived from a cached response and written. */
  written: number
  /** Cached responses exist, and the current checks reject every one. */
  rejected: number
  /** Of those, the ones that were on disk from an earlier run: now deleted. */
  removed: number
  /** Reviewed by a person, and left as they are. */
  reviewed: number
  /** On disk with no cached response for this seed, and left as they are. */
  uncached: number
  /** Left as they are, and failing the current checks: a person must act. */
  failing: string[]
}

export async function rebuild(
  specs: DocumentSpec[],
  options: {
    out: string
    /** The directory of cached responses, `<id>.<attempt>.json`. */
    responses: string
    seed: number
    /** Lower-case strings that identify the operator; see operator.ts. */
    deny: string[]
  },
  log: (line: string) => void = console.log
): Promise<RebuildSummary> {
  let names: string[] = []
  try {
    names = await readdir(options.responses)
  } catch {
    throw new Error(
      `no cached responses in ${path.relative(process.cwd(), options.responses)}`
    )
  }
  const summary: RebuildSummary = {
    written: 0,
    rejected: 0,
    removed: 0,
    reviewed: 0,
    uncached: 0,
    failing: [],
  }

  const keep = (
    id: string,
    document: LabelledDocument,
    why: string,
    quiet: boolean
  ) => {
    const problems = checkKept(document, options.deny)
    if (problems.length > 0) {
      summary.failing.push(id)
      log(
        `! ${id}  ${why}, so kept, but the current checks reject it: ${problems.slice(0, 3).join("; ")}`
      )
    } else if (!quiet) {
      log(`· ${id}  ${why}; kept as it is`)
    }
  }

  for (const spec of specs) {
    const file = documentPath(options.out, spec)
    const onDisk = await readJson<LabelledDocument>(file)
    if (onDisk && isReviewed(onDisk)) {
      summary.reviewed++
      keep(spec.id, onDisk, "reviewed by a person", false)
      continue
    }

    const attempts = names
      .filter((name) => name.startsWith(`${spec.id}.`))
      .map((name) => Number(name.split(".")[1]))
      .sort((a, b) => a - b)
    let usable = 0
    let done = false
    let reasons: string[] = []
    for (const attempt of attempts) {
      const cached = await readJson<CachedResponse>(
        path.join(options.responses, `${spec.id}.${attempt}.json`)
      )
      if (!cached || cached.seed !== options.seed) continue
      usable++
      const result = buildDocument(spec, cached.text, generatorInfo(cached), {
        deny: options.deny,
      })
      if (result.ok) {
        await writeDocument(options.out, spec, result.document)
        done = true
        break
      }
      reasons = result.reasons
    }

    if (done) {
      summary.written++
    } else if (usable === 0) {
      // Nothing to re-derive it from: generated on another machine, or before
      // the cache was cleared. Held to the checks rather than thrown away.
      if (onDisk) {
        summary.uncached++
        keep(spec.id, onDisk, "no cached response to rebuild it from", true)
      }
    } else {
      summary.rejected++
      // What the current checks reject must not stay in the corpus.
      const removed = onDisk !== null || (await exists(file))
      if (removed) {
        await rm(file, { force: true })
        summary.removed++
      }
      log(
        `✗ ${spec.id}  ${reasons.slice(0, 3).join("; ")}${removed ? "  (removed)" : ""}`
      )
    }
  }
  return summary
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}
