<!--
Thanks for this.

CONTRIBUTING.md has the details; this is just the short version of what a
reviewer will look for. Delete anything that does not apply — an empty checkbox
you honestly cannot tick is more useful than a ticked one you did not check.
-->

## What and why

<!-- What changed is in the diff. Explain why. If a test caught a real bug
     while you were in there, say so — that is the most valuable sentence in
     most changelogs. -->

Closes #

## Invariants

Which of the [eight](../blob/main/CONTRIBUTING.md#the-invariants) this touches,
and how it still holds. Skip if it touches none.

- [ ] This changes what reaches an exported file, and there is a test that reads
      the produced artifact and fails without the change.
- [ ] Nothing here logs document content, extracted text, OCR output, prompts or
      keys.
- [ ] Detection still only proposes: nothing is applied without
      `status === "accepted"`.
- [ ] Redaction still removes rather than covers.

## Checks

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] Any new fixture is synthetic. No real personal data, in the diff or in the
      screenshots.
- [ ] Schema change? A migration is committed, not just a `schema.prisma` edit —
      CI fails if the two disagree.

## Screenshots

<!-- For anything visual. Fake names, please. -->
