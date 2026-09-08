<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# A changelog fragment is part of the change

Every pull request that changes what someone running Anonify would notice must
add a file to `changelog.d/` **in the same pull request**. CI fails without one.
Do not open the pull request and add it afterwards — write it while you still
have the reason in mind, because the entry is the one part of the work that
explains *why* to somebody who was not here.

```
changelog.d/<issue-or-pull-request-number>.<section>.md
```

Sections are `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`.
The content is one entry, no leading `-`, written for someone self-hosting
Anonify who is deciding whether to pull:

```markdown
MBOX mailboxes are accepted as an upload, and open as a batch with one
document per message
```

The release workflow assembles these into `CHANGELOG.md`, publishes them as the
GitHub release body, and deletes them in the same commit. Never edit
`CHANGELOG.md` by hand, and never edit the version in `package.json` — both are
written by `.github/workflows/release.yml`.

**When you do not need one.** A pull request whose labels move no version needs
no fragment: documentation, a pure refactor, a change invisible to anyone
running the software. The rule is exactly the release label table in
`CONTRIBUTING.md` — if it produces a release, it needs an entry. If you believe
a change needs no entry, remove the version-bumping label rather than skipping
the fragment.

Details, including what makes a good entry: `changelog.d/README.md`.
