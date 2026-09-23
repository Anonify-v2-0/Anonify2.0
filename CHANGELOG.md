# Changelog

What changed in each release of Anonify, written for someone deciding whether
to pull. What changed in the output, what changed in the configuration, what
needs a migration — not the refactors.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes that have not shipped yet are not listed here. They are one file each in
[`changelog.d/`](changelog.d/), and the release workflow assembles them into a
new section below at the moment it moves the version. See
[CONTRIBUTING.md](CONTRIBUTING.md#releases) for how to write one.

<!-- next-version -->

## [1.6.1] - 2026-09-23

### Added

- The model-assisted analysis pass is now tested in CI without an API key or a
  network call, including the rule that a value the model reports but the
  document does not contain is discarded, and that a failing provider still
  leaves the reviewer with the pattern detections (#30)
- Scanned images are now tested against the real OCR engine in CI, including
  where each word's redaction box lands, so a change that moved image
  redactions off the text they cover would fail before release (#33)

## [1.6.0] - 2026-09-23

### Changed

- Uploads, mailbox and email attachment expansion, and plain text, CSV and TSV
  extraction now stream instead of holding whole files in memory, so a large
  mailbox no longer has to fit in memory at once. New documents are stored in
  1 MB authenticated chunks. Run the database migration before starting this
  version. Documents already stored stay readable exactly as they are.
  `ANONIFY_ENCRYPTION_CHUNK_SIZE` and `ANONIFY_STREAM_MEMORY_BUDGET` tune it, and
  the defaults suit most installs (#102)

### Security

- Each stored file is now bound to the name it was written under. Someone with
  write access to the storage bucket can no longer swap one of a document's
  encrypted files for another, such as its report for its source. This covers
  documents uploaded from this version on (#102)

## [1.5.0] - 2026-09-23

### Added

- An export with a second copy can be downloaded as one zip holding every copy
  and its report. The vault is left out on purpose and is still downloaded on
  its own

### Fixed

- Exports with a second copy (pseudonymized, tokenized or encrypted) work again.
  Every one of them failed with "The export could not be generated", and a
  malformed export request is now answered with a 400 rather than a 500 (#121)
- Accept all leaves suggestions you ignored alone instead of redacting them after
  all, and an ignored suggestion is marked and dimmed in the inspector (#121)
- The export dialog scrolls instead of growing past the screen, and with two
  copies each copy's checksum and report fold away while its downloads and vault
  stay in view (#121)
- The documents list says a review is finished instead of showing "0 accepted"
  under a full progress bar, and the upload panel no longer jumps or sits at 0%
  when an upload starts (#121)
- Undo and redo save only the redactions they changed. Before, pressing Ctrl+Z
  in a tab holding stale decisions could overwrite every decision on the
  document, and undoing a method change was never saved (#121)
- PDFs that use the standard fonts without embedding them, or that need the
  bundled CMaps, render and extract on the server with the right font data
  again. The server was looking for those files at a path it could not read

### Security

- PDF redaction boxes are placed from the font's own character widths and reach
  below the baseline. On a line of proportional text a box could sit a few
  characters away from its value and leave descenders showing, and the export
  burned in the same box, so part of an accepted value could survive in the
  exported PDF. PDFs analysed before this release are covered a whole text run at
  a time instead; upload them again for boxes that fit the value
  (GHSA-h3hv-rpqw-7p84)
- Next.js is updated to 16.3.6, which fixes two critical and several high-severity
  advisories in 16.2.x, and vulnerable copies of undici, mysql2, nanoid,
  deepmerge-ts, devalue, uuid, lodash and postcss pulled in by Prisma, Workflow
  and exceljs are replaced with patched releases, so `pnpm audit` reports nothing

## [1.4.0] - 2026-09-23

### Added

- `pnpm setup` pages and searches large model catalogs, shows each model's
  advertised capabilities and context window apart from what setup verified, and
  can finish a local install for you — starting Postgres and RustFS, migrating,
  warming OCR and starting the app, or running everything in Docker — with retry,
  skip or stop on any step that fails (#119)
- `pnpm setup` shows list prices for models on the Vercel AI Gateway and
  DeepInfra, read from their own model lists and labelled with source and age,
  and offers — never automatically — to save the chosen model's price to
  `AI_MODEL_PRICES`. Model lists are cached in `.cache/models` (or
  `ANONIFY_MODEL_CACHE_PATH`), and `pnpm models:warm` refreshes them (#120)

## [1.3.0] - 2026-09-12

### Added

- AI detection can use official AI SDK providers, including Azure, Bedrock and
  Vertex, or a local Ollama server. Setup discovers models, blocks incompatible
  choices and verifies structured output and image support before saving a model;
  existing AI Gateway configurations continue to work. (#115)

### Changed

- Self-hosted object storage now uses pinned RustFS images instead of archived MinIO Community Edition tooling, reuses the existing data volume, and initializes its S3 bucket idempotently (#117)

## [1.2.0] - 2026-09-08

### Changed

- Release notes are written by the people who make the changes. Each pull request
  that moves the version now carries a fragment in `changelog.d/`, and the release
  workflow assembles them into `CHANGELOG.md` and publishes that as the release
  body — in place of a generated list of pull request titles (#105)

## [1.1.1] - 2026-09-08

### Added

- Email bodies written in HTML are converted to markdown before analysis, so
  detection reads the text a person sees rather than the markup around it. A
  message now folds into its parts — body, alternatives, attachments — each
  handled as its own document (#103)

### Changed

- Releases are cut by a workflow rather than by hand. A merged pull request's
  labels decide which part of the version moves, and the tag, the version in
  `package.json` and the GitHub release can no longer disagree with each other
  (#106, #108, #109, #111)

## [1.1.0] - 2026-09-06

### Added

- MBOX mailboxes are accepted as an upload, and open as a batch with one
  document per message (#100)

## [1.0.0] - 2026-09-06

The first release.

### Added

- Support for CSV, TSV, plain text, RTF, EML and PPTX, alongside the PDF, DOCX,
  XLSX and image formats already handled (#72)
- An email attachment is treated as a document in its own right, and a message
  carrying attachments opens as a batch (#75)
- Anonymisation beyond masking: a method chosen per category, consistent
  variants for a repeated value, and restore for anything applied (#95)
- Exportable reports, batch review, and detection presets named for what they
  look for rather than for how they work (#71)
- A link to the repository throughout the interface (#92)

### Changed

- Batch processing runs with bounded concurrency instead of one document at a
  time (#95)
- Calls to external services are paced and retried, and their limits are
  configuration rather than constants (#97)

### Fixed

- A document that fails partway reports what actually happened instead of a
  generic error, and only the stages that can succeed are retried (#69)
