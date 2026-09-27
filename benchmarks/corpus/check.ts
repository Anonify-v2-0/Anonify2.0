/**
 * Fails if any committed corpus file contains an email address, phone number,
 * URL or IP address outside the reserved ranges, or if its labels do not line
 * up with its text.
 *
 *   pnpm corpus:check
 *   pnpm corpus:check benchmarks/corpus/synthetic-v1
 *
 * The generator already rejects such documents. This runs in CI as well
 * because a corpus file can also be edited by hand, and a real address in a
 * redaction tool's test data is the one mistake here that cannot be taken back
 * by a later commit.
 */

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { scanForIdentifiers } from "./lib/reserved"
import { checkDocument } from "./lib/verify"
import type { LabelledDocument, Locale } from "./lib/types"

const HERE = import.meta.dirname

async function corpusRoots(args: string[]): Promise<string[]> {
  if (args.length > 0) return args.map((arg) => path.resolve(arg))
  const entries = await readdir(HERE, { withFileTypes: true })
  return entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("synthetic-")
    )
    .map((entry) => path.join(HERE, entry.name))
}

/**
 * Every string in a review file, except `value` fields: those quote the
 * document's own text, which is checked with its labels below. The rest —
 * a validator's reasons, a reviewer's notes — is free text written into the
 * repository and is held to the same ranges.
 */
function* freeText(node: unknown, key = ""): Generator<string> {
  if (typeof node === "string") {
    if (key !== "value") yield node
  } else if (Array.isArray(node)) {
    for (const item of node) yield* freeText(item, key)
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) yield* freeText(v, k)
  }
}

/**
 * A review of one document is read in that document's locale, so a phone
 * number quoted from it is judged as it is there. A file about no single
 * document has none: a number written nationally in it is reserved nowhere.
 */
async function checkReviews(
  root: string,
  locales: Map<string, Locale>,
  problems: string[]
): Promise<number> {
  let names: string[] = []
  try {
    names = (await readdir(path.join(root, "review"))).filter((name) =>
      name.endsWith(".json")
    )
  } catch {
    return 0
  }
  for (const name of names) {
    const file = path.join(root, "review", name)
    const where = path.relative(process.cwd(), file)
    let review: unknown
    try {
      review = JSON.parse(await readFile(file, "utf8"))
    } catch {
      problems.push(`${where}: not valid JSON`)
      continue
    }
    const locale = locales.get(name.replace(/\.json$/, "")) ?? null
    for (const text of freeText(review)) {
      for (const finding of scanForIdentifiers(text, locale)) {
        if (!finding.reserved) {
          problems.push(
            `${where}: ${finding.kind} outside the reserved ranges: ${JSON.stringify(finding.value)}`
          )
        }
      }
    }
  }
  return names.length
}

async function main() {
  const roots = await corpusRoots(process.argv.slice(2))
  let files = 0
  const problems: string[] = []

  for (const root of roots) {
    const locales = new Map<string, Locale>()
    let manifest: { files?: Record<string, string> } | null = null
    try {
      manifest = JSON.parse(
        await readFile(path.join(root, "manifest.json"), "utf8")
      )
    } catch {
      manifest = null
    }

    for (const split of ["dev", "test"]) {
      let names: string[] = []
      try {
        names = (await readdir(path.join(root, split)))
          .filter((name) => name.endsWith(".json"))
          .sort()
      } catch {
        continue
      }
      for (const name of names) {
        const relative = `${split}/${name}`
        const where = path.relative(process.cwd(), path.join(root, relative))
        const bytes = await readFile(path.join(root, relative))
        files++
        let document: LabelledDocument
        try {
          document = JSON.parse(bytes.toString("utf8"))
        } catch {
          problems.push(`${where}: not valid JSON`)
          continue
        }
        locales.set(document.id, document.locale)
        for (const problem of checkDocument(document))
          problems.push(`${where}: ${problem}`)
        if (document.split !== split)
          problems.push(
            `${where}: split is "${document.split}" but the file is under ${split}/`
          )

        const expected = manifest?.files?.[relative]
        const actual = createHash("sha256").update(bytes).digest("hex")
        if (manifest && expected !== actual) {
          problems.push(
            `${where}: ${expected ? "does not match its hash in" : "is missing from"} manifest.json — run \`pnpm corpus:generate --manifest\``
          )
        }
      }
    }
    files += await checkReviews(root, locales, problems)
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`)
    console.error(
      `\n${problems.length} problem${problems.length === 1 ? "" : "s"} in ${files} corpus file${files === 1 ? "" : "s"}.`
    )
    process.exitCode = 1
    return
  }
  console.log(
    files === 0
      ? "No corpus files are committed yet; nothing to check."
      : `${files} corpus file${files === 1 ? "" : "s"}: every email, phone number, URL and IP address is in a reserved range, and every label matches its text.`
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
