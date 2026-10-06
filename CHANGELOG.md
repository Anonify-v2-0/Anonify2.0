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

## [1.14.2] - 2026-10-06

### Fixed

- A customer number, or another value a pattern found but was unsure of, is no longer lost when the second-opinion check rejects it: the model now judges it in context too, and a value either one keeps is suggested. Before, such a value was never suggested anywhere in the document (#212)

## [1.14.1] - 2026-10-06

### Changed

- Fewer duplicate suggestions: one that lies inside another of the same category, such as a surname inside the full name, is folded into it, and a value found once is no longer suggested again where it is only part of something longer, such as `raman` inside `priya.raman@example.org` or `C-77104` inside `NC-77104`. A rule you add to redact a value everywhere still matches inside anything (#205)
- A value the patterns found in part and the model completed beside it is now one suggestion: an address's street line and the rest of it, `42 Larch Court, Flat 3, Stowmarket, IP14 2RN`, are joined instead of offered as two (#207)

### Fixed

- Invoice and transaction references such as `TXN-0098-4412-7700` or `INV-000842-710395` are no longer suggested as phone numbers. A number written right after an invoice, reference or registration label is now passed to the model to check, not accepted on its shape alone, and UK numbers with a five-digit area code (`01632 960612`) are now found whole (#203)

## [1.14.0] - 2026-10-01

### Added

- A `health` category: a diagnosis, medication, test result or measurement about a named person is suggested as health, and can only be masked. These details used to be suggested as `confidential` (#197)

### Changed

- Fewer wrong suggestions: the model is now told what each category means and what it does not, so invoice lines, prices and totals are no longer suggested as financial details, and letter or appointment dates are no longer suggested as dates of birth. The benchmark corpus is generated from the same definitions (#197)

## [1.13.0] - 2026-10-01

### Added

- German, French and Spanish documents are read in their own language: the
  language is told from the text, pattern detection finds dates of birth,
  addresses, client references, account numbers and identity numbers (Steuer-ID,
  NIR, DNI and NIE) by the labels and formats those languages use, the model is
  told which language it is reading, and the editor says which language a
  document was read in, or that it could not tell and read it as English. IBANs
  printed in groups of four are now found in every language, and the "Identifiers
  and dates" preset includes the new identity detectors (#43)

## [1.12.1] - 2026-10-01

### Added

- `pnpm bench:models` sets up its own run in a terminal. It names the corpus
  and archive it reads, and asks which split, how many documents and which
  phases to run. It asks which provider, its key or a ChatGPT sign-in, and one
  or more models from the provider's list, each priced at its list price. When
  the run ends or is stopped, it prints what it spent: calls, tokens and cost
  for each model and phase. `pnpm bench:charts` adds a chart of the tokens each
  phase spent and what they cost (#164)

### Changed

- `pnpm bench:models` and `pnpm corpus:score` no longer read `.env`. Their
  keys, models, prices and any ChatGPT sign-in are kept in `benchmarks/.bench/`,
  which git ignores, so benchmarking a model changes nothing the instance uses.
  A run without a terminal reads `BENCH_MODELS` and each provider's key from
  `benchmarks/.bench/.env` or the shell. `corpus:score --detector pipeline` runs
  the saved model, or one named with `--model provider:model`, and verifies it
  before it scores anything (#164)

## [1.12.0] - 2026-09-29

### Added

- The review works on phones and tablets without a keyboard. A labelled bottom
  bar (Redact, Search, Review, Hush, More) replaces the toolbar on small
  screens. A page stepper and pages grid replace the hidden rail. Search keeps
  Redact this and Redact all. The inspector, results, Hush and dialogs become
  sheets you can drag, swipe away and reach with a thumb. On the page, one finger
  scrolls unless the redact tool is on, two fingers zoom, a tap redacts the
  nearest word or opens a menu on a redaction, a touch text selection offers
  Redact selection, and drawn regions can be moved and resized by their handles
  or with the arrow keys (#158)

### Fixed

- PDF pages render in browsers without `Map.prototype.getOrInsertComputed`
  (Chromium before 145, and many phone browsers). pdf.js 6 needs it, and the
  review canvas used to sit on its loading spinner forever there. The browser
  now loads pdf.js's legacy build, which carries its own polyfills

## [1.11.0] - 2026-09-29

### Added

- `S3_PRESIGNED_UPLOADS=true` lets browsers upload straight to an S3 bucket with a
  presigned PUT, signed for the exact length of the encrypted file, instead of
  through `/api/upload/local`. It needs a CORS rule on the bucket and, when
  browsers reach the bucket at a different address than the app does,
  `S3_PUBLIC_ENDPOINT`. `ANONIFY_UPLOAD_ENCRYPTION=required` refuses uploads that
  were not encrypted in the browser (#156)

### Security

- Uploads are encrypted in the browser before they leave the page, under a
  single-use key minted for that one file, so an uploaded file no longer sits in
  storage in the clear while it waits to be processed. On Vercel Blob that was a
  public object. Processing opens the upload, re-seals it under the document's
  own key and destroys the upload key. A damaged upload fails with a new
  `upload-unreadable` code and asks for a re-upload. `/api/documents/:id/process`
  now refuses a storage handle that is not the document's own upload. Browser
  uploads to Vercel Blob get a random suffix in their URL. Two nullable columns
  are added to `Document`, so run `pnpm db:migrate:deploy`. Clients that do not
  ask for a key, such as API scripts and pages served over plain HTTP (where the
  browser has no WebCrypto), still upload plaintext unless
  `ANONIFY_UPLOAD_ENCRYPTION=required` is set (#156)

## [1.10.0] - 2026-09-29

### Added

- Batch downloads ask what to deliver. **Original format** (the default) gives
  back what was uploaded: a mailbox as `inbox-redacted.mbox`, rebuilt from its
  messages' verified exports with separator lines written fresh rather than
  copied, and verified again as a whole before it is sent; a message carrying its
  redacted attachments; a file as itself. **Processed files** is every
  document's own output in folders that mirror where it came from, named by
  message number and part path, never by subject or filename. **Both** is the two
  together. A message left out of a rebuilt mailbox is named in the batch report,
  as is the check a mailbox failed when its own verification withholds it, and an
  expanded mailbox in the workspace offers the rebuilt mailbox directly (#143)

### Changed

- The batch archive is no longer flat: files sit in folders by upload, message
  number and part path, with reports under `reports/`, and
  `GET /api/batches/:id/download` now takes `output=original|processed|both`,
  defaulting to `original` — a single upload comes back as that one file rather
  than a zip (#143)

### Fixed

- A batch holding more than fifty documents — any mailbox of more than fifty
  messages — was exported, downloaded and listed as only its first fifty, and
  from the fifty-first document on the workspace lost its place in the batch: no
  position, no previous or next, and the fiftieth offered no next. Every document
  in a batch is now included, and the workspace can step through all of them.
  Downloading or restoring a file whose upload name is outside Latin-1 —
  `收件箱.mbox`, `Отчёт.pdf`, an emoji — no longer fails, and the file saves
  under its real name (#143)

## [1.9.3] - 2026-09-28

### Fixed

- `pnpm bench:models` verifies each model it benchmarks before its first
  phase, the way `pnpm ai verify` does, for that run only. A model other than
  the one verified in `.env` was previously treated as unsupported, and every
  document was scored on the pattern detectors alone (#59)

## [1.9.2] - 2026-09-28

### Added

- `pnpm bench:models` benchmarks the models set in `.env` (or a
  `BENCH_MODELS` list) on the labelled corpus: recall per category, tokens and
  cost per document, throughput as concurrency rises, and the tokens the
  deterministic pass saves against the same model with it switched off.
  `pnpm bench:charts` draws the results as light and dark charts in the README.
  A model benchmarked later is added beside the earlier ones without changing
  their results (#59)

## [1.9.1] - 2026-09-28

### Added

- `pnpm corpus:generate` builds a synthetic, labelled PII corpus for measuring
  detection quality through the Claude Code or Codex CLI you are already signed
  in to. Every email address and phone number comes from a range reserved for
  fiction, as does every card and ID wherever such a range exists, and a
  document with a real-looking email, phone number, URL or IP address is
  rejected. `pnpm corpus:validate` has a model from another family review the
  labels, and CI fails if a committed corpus file holds a value outside the
  reserved ranges. `pnpm corpus:score` measures what your instance would find in
  it, per category, with the deterministic detectors alone or with the model
  configured in `.env`: precision, recall and a cost that weighs a missed ID
  above a false alarm. `--format pdf` (or docx, eml, csv, xlsx, txt) renders the
  documents to that format and measures them through the same extraction an
  upload goes through (#57)

## [1.9.0] - 2026-09-27

### Added

- Search, RegEx rules, global rules and Hush, a review assistant that works
  through tools with you approving every change, in the review screen.

  `Ctrl/⌘+F` or `/` opens a find strip docked above the document. It searches
  the whole document on the server, not just the pages that are loaded, in
  every format with a review view. It has match case, whole word and RegEx
  options, an "N / M" counter announced to screen readers, and amber highlights.
  A results panel lists every hit in context, grouped by page. Page thumbnails
  show how many hits each page has. From a hit, you can redact that match or
  open a rule for all of them, and optionally see counts across the batch.
  Whole-document searches and rule previews have their own rate limit,
  `ANONIFY_RATE_LIMIT_SEARCH` (600 a minute self-hosted by default).

  Rules can now be RegEx as well as text. RegEx runs on a linear-time engine
  (RE2), so a pattern cannot hang the server; backreferences and lookaround are
  refused, and a rule that matches too much applies nowhere rather than partway.
  Every rule is previewed with its count and matches in context before anything
  is written. Rules can also be global: applied to every document you upload
  from now on, with the pattern encrypted at rest and deleted after 30 days
  unused. They belong to the browser session, whose cookie now renews each time
  you upload or change a rule, so rules in use are not lost when it turns 30
  days old; clearing cookies still ends them. Global rules export and import as
  JSON, which is how to keep them. The inspector has a Rules tab
  where each rule can be switched off, edited with a fresh preview, or removed
  with everything it redacted.

  `Ctrl/⌘+K` opens Hush, which reads, searches and scans the document with
  tools. It lists where a value occurs and whether each occurrence is covered,
  finds what the detectors can see that nothing covers yet, explains
  suggestions, and proposes rules and redactions. Every change it proposes
  appears as a card with its evidence and waits for Approve. Approvals are
  signed by the server, and each change is re-checked against the document
  before it runs. Hush asks once before it first reads a document (it sends
  what it reads to your configured provider), shows every read as it happens,
  and renders replies as streamed Markdown that cannot load links or images.
  It stays within the analysis spend cap and `AiUsage` accounting, and has a
  daily token allowance per visitor, `ANONIFY_QUOTA_ASSISTANT_TOKENS`
  (unlimited on a self-hosted install), checked between steps. It also
  offers rules, locally and without a provider, once you have redacted the same
  shape of value by hand a few times.

  `?` lists every keyboard shortcut, and zoom has a slider.

  This release adds tables and columns, so run `pnpm db:migrate:deploy` before
  starting it. A batch or global rule that matches too much of a newly processed
  document now fails that document with `rule-too-broad`; the document can still
  be reviewed, and retries once the rule is narrowed (#142)

### Fixed

- Clicking text in the review screen redacts the value under the pointer, such
  as an ID, an email address or a name, instead of the whole span it sits in.
  In a text file a span is a whole line, so a click on one ID used to redact the
  line. A value written in groups, such as a card number, a spaced IBAN or a
  phone number, is taken whole, while a name is taken one word at a time.
  Dragging a selection redacts exactly the selection. PDFs get the same
  word-level click, from their measured character positions. The canvas also
  now shows suggestions and accepted redactions over exactly the characters
  they cover. Before, any line with a redaction on it was drawn fully blacked
  out or fully flagged, which overstated what the export removes. Browsers
  without the CSS Custom Highlight API still mark the whole line. Plain-text,
  RTF and slide pages now have thumbnails, and changing page opens the new page
  at its top (#142)

## [1.8.0] - 2026-09-27

### Added

- More places the contextual pass can run. Setup and the new `pnpm ai` command
  offer OpenRouter, Synthetic, LM Studio, llama.cpp, and any other
  OpenAI-compatible endpoint by `AI_BASE_URL`. Each gets the same model
  discovery, verification and visible "unsupported" degradation as the existing
  providers, and adding a vendor is one row in a table. LM Studio and llama.cpp
  are treated like Ollama: no spend, one request at a time, and reachable from
  Docker. `pnpm ai login --provider openai` signs in with a ChatGPT subscription
  and keeps the token sealed in the database, never in `.env`. It then lists
  your plan's models from OpenAI, verifies the one you pick, and offers to record
  a price for it. It uses Codex CLI's public client, and OpenAI's terms decide
  whether a plan may be used this way, so read the caveat in
  `docs/connect-openai.md` and prefer an API key for anything deployed. There is
  no Anthropic subscription sign-in, because Anthropic's terms do not allow it.
  `pnpm ai verify` verifies a model and writes it to `.env` without running the
  rest of setup. `pnpm ai status` shows what is in force: for a ChatGPT
  sign-in, the account, plan and the plan's usage limits from OpenAI, and for
  any provider, the calls and tokens this instance has sent it. A model that fails
  verification now says why: which check failed, the HTTP status, and what the
  provider said, with credentials redacted. Existing configurations and their
  verifications are unchanged (#126)

### Fixed

- Link previews of a self-hosted instance point at its own address instead of
  `http://localhost:3000`. Set `ANONIFY_PUBLIC_URL` to the address people reach
  it at, and rebuild the image after changing it (Docker Compose passes it to the
  build). Vercel deployments keep using their own address, and `next build` no
  longer warns that `metadataBase` is unset (#139)
- The expiry sweep no longer fails with "No record was found for a delete" when
  a document is removed by something else while the sweep is running, for
  example a person deleting it, `pnpm cleanup`, or a second sweep. A document
  already gone now counts as deleted, and one document that cannot be purged no
  longer stops the rest of the run: it is counted, logged and retried next time (#140)

### Security

- A standalone build (`NEXT_OUTPUT=standalone`) no longer copies the working tree
  into its server output. Before, it copied the source, tests and docs, every
  document in local storage (`.anonify-storage`), and downloaded OCR models.
  Documents stay encrypted, but the build also carries `.env` with the key that
  opens them. Container images and Vercel deployments were not affected, since
  neither build sees those folders. If you built standalone on a machine that
  stores documents locally and copied `.next/standalone` elsewhere, delete that
  copy's `.anonify-storage`. The output is also smaller (about 155 MB down to
  138 MB here), and `next build` no longer warns about tracing the whole project (#139)

## [1.7.0] - 2026-09-27

### Changed

- Documents are read a piece at a time instead of whole, so processing and
  downloading a large file needs far less memory. The editor loads the pages you
  look at rather than the whole document; Word, PowerPoint, Excel and PDF files
  are read by ranged reads, with pictures and other media no longer unpacked;
  emails are parsed without holding their attachments; and downloads, single and
  batch, stream while their checksum is verified. Output is unchanged. Adds a
  `Document.normalizedIndex` column, so run `pnpm db:migrate:deploy` (the
  container image does this for you); documents processed before the upgrade
  keep working and are read whole (#129)

### Fixed

- A download the browser abandoned partway no longer leaves the stored file's
  handle or storage connection open until the process cleans it up (#129)

## [1.6.3] - 2026-09-23

### Fixed

- A document that needs OCR now fails at once, as a configuration problem an
  administrator has to fix, when `OCR_PROVIDER=mistral` has no `MISTRAL_API_KEY`
  — instead of being retried five times and reported as an unknown error with a
  retry button. When a Mistral key is set under another name, such as
  `MISTRAL_AI_KEY`, the error names it and says to rename it (#134)

## [1.6.2] - 2026-09-23

### Fixed

- Image and PDF-page analysis works with local vision models such as Qwen3-VL
  through Ollama. The model is now asked for region coordinates as whole numbers
  on a 0–1000 grid, the convention those models answer in, rather than 0–1
  fractions they ignored, which failed validation and left every image with no
  suggestions. An over-long region explanation is shortened rather than
  discarding the region (#132)

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
