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
 *
 * What is committed is the archive, `<corpus>.tar.gz`, so that is what is
 * checked, file by file, without unpacking it. A corpus with no archive is
 * checked from its directory. Where both exist, as on a machine that has run
 * the scripts, the directory must match the archive: a hand edit that was
 * never packed is a change that would not be committed.
 */

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { readArchive, readWorkingCopy } from "./lib/archive"
import { scanForIdentifiers } from "./lib/reserved"
import { checkDocument } from "./lib/verify"
import type { LabelledDocument, Locale } from "./lib/types"

const HERE = import.meta.dirname

async function corpusRoots(args: string[]): Promise<string[]> {
  if (args.length > 0) return args.map((arg) => path.resolve(arg))
  const entries = await readdir(HERE, { withFileTypes: true })
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.name.startsWith("synthetic-")) continue
    if (entry.isDirectory()) names.add(entry.name)
    else if (entry.name.endsWith(".tar.gz"))
      names.add(entry.name.slice(0, -".tar.gz".length))
  }
  return [...names].sort().map((name) => path.join(HERE, name))
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
 * A validator's reason may quote one of the document's labelled values, a
 * generated national id say, which the document's own check has passed.
 */
function checkReviews(
  files: Map<string, Buffer>,
  where: (file: string) => string,
  documents: Map<string, { locale: Locale; labelled: Set<string> }>,
  problems: string[]
): number {
  let count = 0
  for (const [file, bytes] of files) {
    const match = /^review\/([^/]+)\.json$/.exec(file)
    if (!match) continue
    count++
    let review: unknown
    try {
      review = JSON.parse(bytes.toString("utf8"))
    } catch {
      problems.push(`${where(file)}: not valid JSON`)
      continue
    }
    const document = documents.get(match[1])
    for (const text of freeText(review)) {
      for (const finding of scanForIdentifiers(
        text,
        document?.locale ?? null
      )) {
        if (!finding.reserved && !document?.labelled.has(finding.value)) {
          problems.push(
            `${where(file)}: ${finding.kind} outside the reserved ranges: ${JSON.stringify(finding.value)}`
          )
        }
      }
    }
  }
  return count
}

/** Where the working copy and the archive disagree, if both exist. */
function unpacked(
  archived: Map<string, Buffer>,
  local: Map<string, Buffer>,
  name: string,
  problems: string[]
) {
  if (local.size === 0) return
  const differ = [
    ...[...local].filter(([file, bytes]) => !archived.get(file)?.equals(bytes)),
    ...[...archived.keys()]
      .filter((file) => !local.has(file))
      .map((file) => [file] as const),
  ].map(([file]) => file)
  if (differ.length === 0) return
  problems.push(
    `${name}: ${differ.length} file(s) differ from ${name}.tar.gz (${differ.slice(0, 3).join(", ")}${differ.length > 3 ? ", …" : ""}). \`pnpm corpus:pack\` puts your changes in the archive; \`pnpm corpus:unpack\` takes the archive's.`
  )
}

async function main() {
  const roots = await corpusRoots(process.argv.slice(2))
  let files = 0
  const problems: string[] = []

  for (const root of roots) {
    const name = path.basename(root)
    const archived = await readArchive(root)
    const local = await readWorkingCopy(root)
    const corpus = archived ?? local
    if (archived) unpacked(archived, local, name, problems)
    const where = (file: string) =>
      archived
        ? `${name}.tar.gz:${file}`
        : path.relative(process.cwd(), path.join(root, file))

    let manifest: { files?: Record<string, string> } | null = null
    try {
      manifest = JSON.parse(
        await readFile(path.join(root, "manifest.json"), "utf8")
      )
    } catch {
      manifest = null
    }

    const documents = new Map<
      string,
      { locale: Locale; labelled: Set<string> }
    >()
    for (const [file, bytes] of corpus) {
      const match = /^(dev|test)\/[^/]+\.json$/.exec(file)
      if (!match) continue
      files++
      let document: LabelledDocument
      try {
        document = JSON.parse(bytes.toString("utf8"))
      } catch {
        problems.push(`${where(file)}: not valid JSON`)
        continue
      }
      documents.set(document.id, {
        locale: document.locale,
        labelled: new Set((document.spans ?? []).map((span) => span.value)),
      })
      for (const problem of checkDocument(document))
        problems.push(`${where(file)}: ${problem}`)
      if (document.split !== match[1])
        problems.push(
          `${where(file)}: split is "${document.split}" but the file is under ${match[1]}/`
        )

      const expected = manifest?.files?.[file]
      const actual = createHash("sha256").update(bytes).digest("hex")
      if (manifest && expected !== actual) {
        problems.push(
          `${where(file)}: ${expected ? "does not match its hash in" : "is missing from"} manifest.json — run \`pnpm corpus:generate --manifest\``
        )
      }
    }
    for (const file of Object.keys(manifest?.files ?? {})) {
      if (!corpus.has(file))
        problems.push(
          `${name}/manifest.json lists ${file}, which is not in the corpus — run \`pnpm corpus:generate --manifest\``
        )
    }
    files += checkReviews(corpus, where, documents, problems)
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
