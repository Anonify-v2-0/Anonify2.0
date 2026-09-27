/**
 * The cross-family validator pass over a generated corpus (issue #57, step 5).
 *
 *   pnpm corpus:validate                          # Codex reviews a Claude-written corpus
 *   pnpm corpus:validate --backend claude         # the other way round
 *   pnpm corpus:validate --ids syn-v1-0042
 *
 * A model from a different family than the generator reads each document with
 * its labels inline and flags anything it thinks is personal data but
 * unlabelled, or labelled but not personal data. It changes nothing. Each
 * document with a disagreement gets `review/<id>.json` for a person to settle,
 * which a later pass adds to rather than replaces (see nextReview in
 * lib/review.ts). `review/validated.json` records what was validated against
 * which file hash, so the pass is resumable and a document edited afterwards
 * is validated again. `review/spot-check.json` names the 10% of the test split
 * a person checks whether or not anything was flagged, and grows with it.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { int } from "./lib/args"
import { createBackend, DEFAULT_MODELS } from "./lib/backends"
import { listDocumentFiles } from "./lib/manifest"
import {
  drawSpotCheck,
  nextReview,
  readReview,
  REVIEW_PROMPT_VERSION,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  reviewUserPrompt,
  type ReviewFile,
  type SpotCheck,
} from "./lib/review"
import type { LabelledDocument } from "./lib/types"

const HERE = import.meta.dirname

const USAGE = `Usage: pnpm corpus:validate [options]

  --backend <name>      codex (default), claude, or command — use a different
                        family from the one that generated the corpus
  --model <id>          model for the backend (codex: ${DEFAULT_MODELS.codex}, claude: ${DEFAULT_MODELS.claude})
  --command <shell>     for --backend command
  --backend-arg <arg>   extra argument for the CLI; repeatable
  --corpus <dir>        corpus directory (default benchmarks/corpus/synthetic-v1)
  --ids <a,b,...>       only these documents
  --limit <n>           stop after this many documents
  --concurrency <n>     requests in flight (default 4)
  --thinking <tokens>   Claude's extended-thinking budget (default 0: off)
  --timeout <seconds>   per request (default 600)
  --force               validate documents again even if unchanged
`

type Validated = Record<
  string,
  {
    sha256: string
    backend: string
    model: string
    promptVersion: string
    disagreements: number
    unlocated: number
    validatedAt: string
  }
>

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** Families, so the pass can refuse to have a model mark its own homework. */
function family(backend: string, model: string): string {
  if (backend === "claude" || /claude|anthropic/i.test(model))
    return "anthropic"
  if (backend === "codex" || /gpt|openai|o\d/i.test(model)) return "openai"
  return `${backend}/${model}`
}

async function main() {
  const { values } = parseArgs({
    options: {
      backend: { type: "string", default: "codex" },
      model: { type: "string" },
      command: { type: "string" },
      "backend-arg": { type: "string", multiple: true, default: [] },
      corpus: { type: "string", default: path.join(HERE, "synthetic-v1") },
      ids: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "4" },
      timeout: { type: "string", default: "600" },
      thinking: { type: "string", default: "0" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return
  }

  const limit =
    values.limit === undefined ? Infinity : int("limit", values.limit)
  const concurrency = int("concurrency", values.concurrency, 1)
  const timeoutMs = int("timeout", values.timeout, 1) * 1000
  const thinkingTokens = int("thinking", values.thinking)

  const root = path.resolve(values.corpus)
  const reviewDir = path.join(root, "review")
  const cacheDir = path.join(HERE, ".cache", path.basename(root), "reviews")
  const backend = createBackend({
    backend: values.backend,
    model: values.model,
    command: values.command,
    extraArgs: values["backend-arg"],
    timeoutMs,
    thinkingTokens,
  })

  const wanted = values.ids
    ? new Set(values.ids.split(",").map((id) => id.trim()))
    : null
  const files = (await listDocumentFiles(root)).filter(
    (file) => !wanted || wanted.has(path.basename(file, ".json"))
  )
  if (files.length === 0)
    throw new Error(`no documents in ${path.relative(process.cwd(), root)}`)

  const validatedFile = path.join(reviewDir, "validated.json")
  const validated = await readJson<Validated>(validatedFile, {})

  // The 10% human spot-check of the test split: chosen once, topped up as the
  // split grows.
  const spotCheckFile = path.join(reviewDir, "spot-check.json")
  const previousSpotCheck = await readJson<SpotCheck | null>(
    spotCheckFile,
    null
  )
  const testIds = (await listDocumentFiles(root))
    .filter((file) => file.startsWith("test/"))
    .map((file) => path.basename(file, ".json"))
  const { spotCheck, added } = drawSpotCheck(
    path.basename(root),
    testIds,
    previousSpotCheck
  )
  if (spotCheck !== previousSpotCheck) {
    await writeJson(spotCheckFile, spotCheck)
    console.log(
      previousSpotCheck
        ? `The test split has grown to ${testIds.length}: added ${added.length} to the human spot-check, now ${spotCheck.ids.length}: review/spot-check.json`
        : `Chose ${spotCheck.ids.length} of ${testIds.length} test documents for the human spot-check: review/spot-check.json`
    )
  }

  const queue: { file: string; document: LabelledDocument; sha256: string }[] =
    []
  let sameFamily = 0
  for (const file of files) {
    const bytes = await readFile(path.join(root, file))
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const document = JSON.parse(bytes.toString("utf8")) as LabelledDocument
    if (
      family(document.generator.backend, document.generator.model) ===
      family(backend.name, backend.model)
    ) {
      sameFamily++
    }
    const previous = validated[document.id]
    if (
      !values.force &&
      previous?.sha256 === sha256 &&
      previous.model === backend.model &&
      previous.promptVersion === REVIEW_PROMPT_VERSION
    ) {
      continue
    }
    queue.push({ file, document, sha256 })
  }
  if (sameFamily > 0) {
    console.warn(
      `⚠ ${sameFamily} document(s) were generated by the same model family as ${backend.name} (${backend.model}). A model is a poor judge of its own writing; use a validator from another family.\n`
    )
  }
  const work = queue.slice(0, limit)
  console.log(
    `Validating ${work.length} of ${files.length} documents with ${backend.name} (${backend.model}).\n`
  )

  let next = 0
  let agreed = 0
  let flagged = 0
  let failed = 0
  let fatal: string | null = null
  const worker = async () => {
    while (next < work.length && !fatal) {
      const { document, sha256 } = work[next++]
      let raw: string
      try {
        const completion = await backend.complete({
          system: REVIEW_SYSTEM_PROMPT,
          user: reviewUserPrompt(document),
          schema: REVIEW_SCHEMA,
        })
        raw = completion.text
        await writeJson(path.join(cacheDir, `${document.id}.json`), {
          backend: backend.name,
          model: backend.model,
          promptVersion: REVIEW_PROMPT_VERSION,
          sha256,
          text: raw,
        })
      } catch (error) {
        const message = (error as Error).message
        if (
          /not found on PATH|log ?in|logged in|authenticat|api key/i.test(
            message
          )
        )
          fatal = message
        failed++
        console.log(`✗ ${document.id}  ${message.split("\n")[0]}`)
        continue
      }

      let result
      try {
        result = readReview(document, raw)
      } catch (error) {
        failed++
        console.log(
          `✗ ${document.id}  unreadable response: ${(error as Error).message}`
        )
        continue
      }
      validated[document.id] = {
        sha256,
        backend: backend.name,
        model: backend.model,
        promptVersion: REVIEW_PROMPT_VERSION,
        disagreements: result.disagreements.length,
        unlocated: result.unlocated,
        validatedAt: new Date().toISOString(),
      }
      const reviewFile = path.join(reviewDir, `${document.id}.json`)
      const outcome = nextReview(
        await readJson<ReviewFile | null>(reviewFile, null),
        {
          id: document.id,
          documentSha256: sha256,
          validator: {
            backend: backend.name,
            model: backend.model,
            promptVersion: REVIEW_PROMPT_VERSION,
          },
          validatedAt: validated[document.id].validatedAt,
          disagreements: result.disagreements,
        }
      )
      if (outcome.write) await writeJson(reviewFile, outcome.review)
      const claims = outcome.added
        .map((d) => `${d.kind} ${JSON.stringify(d.value)}`)
        .join(", ")
      const repeated =
        outcome.repeated > 0
          ? `${outcome.repeated} claim(s) already in review/${document.id}.json`
          : ""
      if (outcome.review?.status === "open") {
        flagged++
        const detail = [
          outcome.reopened ? `reopened: ${claims}` : claims,
          repeated,
        ].filter(Boolean)
        console.log(
          `! ${document.id}  ${detail.join("; ") || `review/${document.id}.json is still open`}`
        )
      } else {
        agreed++
        const detail = outcome.superseded
          ? `review/${document.id}.json superseded: the document changed and nothing is flagged now`
          : repeated && `${repeated}, settled`
        console.log(`✓ ${document.id}${detail ? `  ${detail}` : ""}`)
      }
      await writeJson(
        validatedFile,
        Object.fromEntries(Object.entries(validated).sort())
      )
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, work.length) }, worker)
  )

  console.log(
    `\n${agreed} agreed, ${flagged} flagged for a person (review/<id>.json), ${failed} failed.`
  )
  if (fatal) {
    console.error(`\nStopped: ${fatal}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
