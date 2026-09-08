# Changelog fragments

One file per change that will appear in a release. The release workflow
assembles everything here into a new section of
[`CHANGELOG.md`](../CHANGELOG.md), publishes it as the GitHub release body, and
deletes the fragments in the same commit. So a listing of this directory is the
answer to "what is going out in the next release".

Fragments live in their own files rather than in an `## Unreleased` section
because that section would be three lines that every open pull request edits,
and every one of them would conflict with the others. Two people adding entries
here add two files.

## Writing one

Name the file for the issue or pull request it belongs to, and for the section
it belongs in:

```
changelog.d/<number>.<section>.md
```

```
changelog.d/105.added.md
changelog.d/88.fixed.md
changelog.d/103.security.md
```

The sections are the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
ones — `added`, `changed`, `deprecated`, `removed`, `fixed`, `security` — and the
number becomes a `(#105)` reference on the entry. A name that is not a number is
accepted and simply carries no reference.

The content is the entry itself, without a leading `-`:

```markdown
MBOX mailboxes are accepted as an upload, and open as a batch with one
document per message
```

## What to write

Write for someone self-hosting Anonify who is deciding whether to pull. What
changed in the output, what changed in the configuration, what needs a
migration. Not the refactors — if a change is invisible to someone running it,
it does not need a fragment, and its pull request should carry no
version-bumping label either.

`security` matters more here than in most projects. A change to what survives a
redaction belongs in a section a reader scans for.

## When one is required

CI asks for a fragment on any pull request whose labels move the version —
`enhancement`, `formats`, `bug`, `performance`, `testing`, and the rest of the
table in [CONTRIBUTING.md](../CONTRIBUTING.md#releases). A `docs`-only pull
request releases nothing and needs none.
