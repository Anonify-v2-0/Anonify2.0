// Turns the fragments in `changelog.d/` into a CHANGELOG.md section.
//
// The alternative was an `## Unreleased` heading that every pull request edits,
// and the reason it was not chosen is that every pull request would then
// conflict with every other pull request touching the same three lines. A
// fragment per change conflicts with nothing: two people adding entries add two
// files.
//
// The cost is this script, and a directory of scraps between releases. The
// scraps are the point — a listing of `changelog.d/` is a readable answer to
// "what is going out next", which an `Unreleased` section only approximates.
//
// Called by `release.yml` after the version is decided and before the bump is
// committed, so the assembled changelog rides along in the same pull request as
// the version it describes. Plain node with no dependencies: the release job
// never installs the workspace.

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * The sections, in the order Keep a Changelog puts them.
 *
 * A fragment names its section in its filename — `105.added.md` — so the
 * section is chosen by the person who knows what the change was, not inferred
 * later from a label by something that does not.
 */
export const SECTIONS = [
  "added",
  "changed",
  "deprecated",
  "removed",
  "fixed",
  "security",
]

const HEADING = {
  added: "Added",
  changed: "Changed",
  deprecated: "Deprecated",
  removed: "Removed",
  fixed: "Fixed",
  security: "Security",
}

/**
 * Where a new version's section is inserted. Everything below this marker is
 * history, newest first; nothing above it is.
 */
export const MARKER = "<!-- next-version -->"

const FRAGMENT = /^(?<name>.+)\.(?<type>[a-z]+)\.md$/

/**
 * Reads every fragment in a directory.
 *
 * A file whose name does not parse is an error rather than something to skip.
 * A typo like `105.fix.md` would otherwise be silently dropped, and the entry
 * it holds would be missing from a release nobody thought to check.
 */
export function readFragments(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const fragments = []

  for (const file of names.sort()) {
    // The directory's own documentation, and the placeholder that keeps an
    // otherwise empty directory in git.
    if (file === "README.md" || file === ".gitkeep") continue

    const match = FRAGMENT.exec(file)
    if (!match) {
      throw new Error(
        `${file} is not a changelog fragment. Name it <number>.<type>.md, where <type> is one of: ${SECTIONS.join(", ")}.`
      )
    }

    const { name, type } = match.groups
    if (!SECTIONS.includes(type)) {
      throw new Error(
        `${file} has an unknown section "${type}". Use one of: ${SECTIONS.join(", ")}.`
      )
    }

    const text = readFileSync(join(dir, file), "utf8").trim()
    if (!text)
      throw new Error(`${file} is empty. Say what changed, or delete it.`)

    fragments.push({
      file,
      path: join(dir, file),
      name,
      type,
      // Fragments are named for an issue or pull request, so a numeric name is
      // a reference worth keeping. A slug is accepted and simply carries none.
      reference: /^\d+$/.test(name) ? Number(name) : null,
      text,
    })
  }

  return fragments
}

/**
 * One fragment as a markdown bullet.
 *
 * Multi-line fragments keep their shape — a continuation line is indented to
 * stay part of the bullet rather than becoming a sibling paragraph.
 */
export function renderEntry({ text, reference }) {
  const lines = text.split("\n").map((line) => line.trimEnd())

  // The reference goes at the end of the entry, not the end of its first line —
  // a wrapped sentence would otherwise be interrupted by "(#88)" in the middle
  // of itself. Only added when the author has not already written it.
  const last = lines.length - 1
  if (reference !== null && !text.includes(`#${reference}`)) {
    lines[last] = `${lines[last]} (#${reference})`
  }

  const rest = lines
    .slice(1)
    .map((line) => (line ? `  ${line}` : ""))
    .join("\n")

  return rest ? `- ${lines[0]}\n${rest}` : `- ${lines[0]}`
}

/**
 * The body of a version's section: its headings and bullets, without the
 * version heading itself.
 *
 * The version heading is left off because this same text becomes the GitHub
 * release body, where the release is already titled with its version and a
 * second copy of it reads like a mistake.
 */
export function renderBody(fragments) {
  if (fragments.length === 0) {
    return "_No user-facing changes were recorded for this release._"
  }

  const blocks = []

  for (const type of SECTIONS) {
    const inSection = fragments
      .filter((fragment) => fragment.type === type)
      .sort((a, b) => (a.reference ?? Infinity) - (b.reference ?? Infinity))

    if (inSection.length === 0) continue

    blocks.push(
      `### ${HEADING[type]}\n\n${inSection.map(renderEntry).join("\n")}`
    )
  }

  return blocks.join("\n\n")
}

/** A full section, version heading included, ready to sit in CHANGELOG.md. */
export function renderSection(version, date, fragments) {
  return `## [${version}] - ${date}\n\n${renderBody(fragments)}`
}

/**
 * Puts a section into the changelog directly below the marker.
 *
 * Anchored on the marker rather than on "the first heading" so that the
 * preamble can be rewritten freely without quietly changing where releases
 * land.
 */
export function insertSection(changelog, section) {
  const at = changelog.indexOf(MARKER)
  if (at === -1) {
    throw new Error(
      `CHANGELOG.md has no ${MARKER} marker, so there is nowhere to put the new section.`
    )
  }

  const head = changelog.slice(0, at + MARKER.length)
  const tail = changelog.slice(at + MARKER.length).replace(/^\n+/, "")

  return `${head}\n\n${section}\n\n${tail}`
}

function main(argv) {
  const args = new Map()
  const positional = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") args.set(arg, true)
    else if (arg.startsWith("--")) args.set(arg, argv[(i += 1)])
    else positional.push(arg)
  }

  const version = positional[0]
  if (!version) {
    process.stderr.write(
      "usage: node scripts/changelog.mjs <version> [--date YYYY-MM-DD] [--dir changelog.d] [--file CHANGELOG.md] [--body-out FILE] [--dry-run]\n"
    )
    return 1
  }

  const dir = args.get("--dir") ?? "changelog.d"
  const file = args.get("--file") ?? "CHANGELOG.md"
  const date = args.get("--date") ?? new Date().toISOString().slice(0, 10)
  const bodyOut = args.get("--body-out")
  const dryRun = args.get("--dry-run") === true

  const fragments = readFragments(dir)
  const body = renderBody(fragments)
  const section = renderSection(version, date, fragments)

  if (bodyOut) writeFileSync(bodyOut, `${body}\n`)

  if (dryRun) {
    process.stdout.write(`${section}\n`)
    process.stderr.write(
      `\n${fragments.length} fragment(s) would be consumed; nothing was written.\n`
    )
    return 0
  }

  writeFileSync(file, insertSection(readFileSync(file, "utf8"), section))

  // The fragments are deleted in the same commit that publishes them, so the
  // directory always holds exactly what has not shipped yet.
  for (const fragment of fragments) unlinkSync(fragment.path)

  process.stdout.write(`${section}\n`)
  process.stderr.write(
    `\nWrote ${file} and consumed ${fragments.length} fragment(s).\n`
  )
  return 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)))
}
