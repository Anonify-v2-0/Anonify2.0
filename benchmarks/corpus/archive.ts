/**
 * The committed corpus archive and its working copy (see lib/archive.ts).
 *
 *   pnpm corpus:unpack      # the archive into benchmarks/corpus/synthetic-v1/
 *   pnpm corpus:unpack --force   # and discard whatever differs from it
 *   pnpm corpus:status      # what differs between the two
 *   pnpm corpus:pack        # the working copy back into the archive
 *
 * generate and validate unpack before they start and pack when they finish,
 * so these are for a change made by hand, such as settling a review file.
 * Every command takes a corpus directory, benchmarks/corpus/synthetic-v1 by
 * default.
 */

import path from "node:path"

import {
  describeSync,
  pack,
  readArchive,
  readWorkingCopy,
  unpack,
} from "./lib/archive"

const HERE = import.meta.dirname

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes("--force")
  const [command = "", corpus = path.join(HERE, "synthetic-v1")] = args.filter(
    (arg) => arg !== "--force"
  )
  const root = path.resolve(corpus)
  const name = path.relative(process.cwd(), root)

  if (command === "unpack") {
    const result = await unpack(root, { force })
    if (!result.archive) throw new Error(`${name}.tar.gz does not exist`)
    console.log(
      describeSync(root, result) ?? `${name} is up to date with its archive.`
    )
    if (result.conflicts.length) process.exitCode = 1
    return
  }

  if (command === "pack") {
    const result = await pack(root)
    console.log(
      result.changed
        ? `Packed ${result.files} files into ${name}.tar.gz (${(result.bytes / 1024 / 1024).toFixed(1)} MB). Commit it with ${name}/manifest.json.`
        : `${name}.tar.gz already holds these ${result.files} files; nothing to pack.`
    )
    return
  }

  if (command === "status") {
    const archived = (await readArchive(root)) ?? new Map<string, Buffer>()
    const local = await readWorkingCopy(root)
    const added = [...local.keys()].filter((file) => !archived.has(file))
    const missing = [...archived.keys()].filter((file) => !local.has(file))
    const changed = [...local].filter(
      ([file, bytes]) =>
        archived.has(file) && !archived.get(file)!.equals(bytes)
    )
    for (const file of added) console.log(`+ ${file}`)
    for (const [file] of changed) console.log(`~ ${file}`)
    for (const file of missing) console.log(`- ${file}`)
    console.log(
      added.length + changed.length + missing.length === 0
        ? `${name} matches its archive (${archived.size} files).`
        : `\n${added.length} new, ${changed.length} changed and ${missing.length} missing here compared with ${name}.tar.gz. \`pnpm corpus:pack\` writes them to it; \`pnpm corpus:unpack\` brings in what only the archive changed.`
    )
    return
  }

  throw new Error(
    "usage: tsx benchmarks/corpus/archive.ts pack|unpack [--force]|status [corpus-dir]"
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
