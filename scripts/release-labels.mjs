// Which part of the version a pull request moves, decided by its labels.
//
// This is one file because two workflows need the same answer and must not
// drift apart. `release.yml` turns it into a version number; `ci.yml` uses it
// to decide whether a pull request owes a changelog fragment — and a label that
// bumps the version is exactly a label that changes something worth writing
// down. Two copies of this table would eventually disagree, and the failure
// would be silent: a release with no entry, or a check demanding a fragment
// nothing will ever read.
//
// Plain node with no dependencies, because both callers run it on a bare runner
// that never installs the workspace.

import { pathToFileURL } from "node:url"

/**
 * Labels that make a release a minor: something new that was not there before.
 */
const MINOR = ["enhancement", "formats"]

/**
 * Labels that make a release a patch: the same product, working better.
 *
 * `security` is here deliberately. A fix to a redaction bypass is urgent, not
 * incompatible, and urgency is what SECURITY.md and the release notes are for.
 */
const PATCH = [
  "bug",
  "performance",
  "testing",
  "ci",
  "infrastructure",
  "ux",
  "accessibility",
  "security",
  "benchmark",
]

// No label maps to `major`. A 2.0.0 says something about compatibility and
// support that a label cannot carry, and that a reviewer applying labels is not
// being asked. Majors are dispatched by hand, by an admin.
const RANK = { none: 0, patch: 1, minor: 2, major: 3 }

/** The bump a single label asks for, or "none" if it asks for nothing. */
export function bumpForLabel(label) {
  if (MINOR.includes(label)) return "minor"
  if (PATCH.includes(label)) return "patch"
  return "none"
}

/**
 * The bump a set of labels asks for, highest wins.
 *
 * A pull request labelled `bug` and `enhancement` is a minor; `docs` alongside
 * `bug` is still a patch, because `docs` does not veto, it only fails to raise.
 * That is the safe direction to be wrong in: under-bumping a feature hides it
 * from anyone reading version numbers to decide whether to pull, while
 * over-bumping a fix costs a number nobody is short of.
 */
export function resolveBump(labels) {
  let bump = "none"
  const matched = []

  for (const label of labels) {
    const asked = bumpForLabel(label)
    if (asked === "none") continue

    matched.push({ label, bump: asked })
    if (RANK[asked] > RANK[bump]) bump = asked
  }

  return { bump, matched }
}

/** True when a pull request with these labels will produce a release. */
export function bumpsVersion(labels) {
  return resolveBump(labels).bump !== "none"
}

function parseLabels(raw) {
  if (!raw) return []

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []

  // `toJSON(github.event.pull_request.labels.*.name)` gives an array of names.
  // Accept whole label objects too, so a caller passing the API's own shape is
  // not silently answered with "none".
  return parsed.map((entry) =>
    typeof entry === "string" ? entry : (entry?.name ?? "")
  )
}

function main(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1])

  const labels = parseLabels(args.get("--labels"))
  const pr = args.get("--pr")
  const { bump, matched } = resolveBump(labels)

  // One field, for a caller that wants a value rather than a set of outputs.
  const field = args.get("--field")
  if (field === "bump") {
    process.stdout.write(`${bump}\n`)
    return 0
  }

  const subject = pr ? `#${pr}` : "This pull request"
  const why =
    bump === "none"
      ? `${subject} carries no label that maps to a version bump.`
      : `${subject} is a ${bump} — ${matched
          .map(({ label, bump: asked }) => `${label} -> ${asked}`)
          .join(", ")}.`

  // Written in the shape of a GitHub Actions step output, so the caller can
  // append it to $GITHUB_OUTPUT without reformatting it.
  process.stdout.write(`bump=${bump}\nwhy=${why}\n`)
  return 0
}

// Run as a script, not when imported by a test.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)))
}
