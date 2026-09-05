# Anonify

AI-assisted document redaction. Upload a PDF, Word document, spreadsheet,
deck, email, CSV, text file or image; the system proposes what looks sensitive;
you decide; the export removes it.

The governing rule: **AI proposes, the application applies, and only what a
person accepted is removed.** A beautiful editor that leaves the original text
under a black rectangle is not a redaction system.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The four layers, request paths, identity, encryption, deliberate limits |
| [docs/workflow.md](docs/workflow.md) | The durable pipeline, its steps, streaming, expiry, failure modes |
| [docs/ai-engine.md](docs/ai-engine.md) | Detection order, cost discipline, prompts, suggestion → decision → removal |
| [docs/pipelines.md](docs/pipelines.md) | Why each format's pipeline is built the way it is |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The invariants, the roadmap, and the benchmarks we would like |

## Where this came from

This is the successor to [nabeel-w/Anonify](https://github.com/nabeel-w/Anonify)
— a Flask + React service that extracted PDF text with `pdfminer.six`, ran a
spaCy NER model fine-tuned on a Kaggle PII dataset over it, masked the detected
entities, and rebuilt the document with `reportlab`. Three redaction levels
(High / Medium / Low) selected which entity labels to act on, and Socket.io
streamed progress back to the browser.

It got the hardest thing right. Because it **rebuilt the PDF from text rather
than drawing over the original**, the redacted content genuinely was not in the
output file. That is more than most redaction tools manage, and this version
inherits the principle rather than replacing it.

What it could not do is what drove the rewrite.

### The constraints

**Rebuilding the document destroyed it.** `reportlab` wrote a fresh PDF of
word-wrapped text. Layout, fonts, tables, images, columns, headers and footers
did not survive. The old README listed formatting preservation as future work,
which is the right diagnosis: a redaction tool people route around because it
mangles the document has not solved their problem.

**Detection was a fixed vocabulary.** A NER model recognizes the labels it was
trained on — `NAME_STUDENT`, `EMAIL`, `PHONE_NUM`, `ID`, `URL_PERSONAL`. Adding
IBANs, API keys, or "customer reference" meant assembling labelled data and
retraining `model-best`. And NER answers a categorical question: it tags *Apple*
as an organization whether the document is a fruit invoice or a customer file.
It cannot weigh whether a given mention is sensitive **here**.

**Levels are a blunt instrument.** High / Medium / Low is one global dial across
the whole document. There was no way to keep one name and remove another, and no
review step between detection and output — the model's judgement was the final
judgement. Manual annotation was, again, listed as future work.

**One format.** PDF only; Word and spreadsheets were on the roadmap.

**Weight.** `en_core_web_lg` plus a fine-tuned model is hundreds of megabytes
resident in every container instance, for a workload that is idle most of the
time.

### Why language models — and where they are *not* used

The shift is narrower than "replace NER with an LLM", and the boundary is the
interesting part.

A language model is genuinely better at exactly one thing here: **contextual
judgement**. `Customer: Apple Inc. / Account manager: John Smith` needs a reader
that understands roles, not a tagger that emits entity types. Extending coverage
becomes a prompt and a schema rather than a labelling effort.

But a language model is worse at everything a regular expression already does
well. It is non-deterministic, it costs money per token, and it can produce a
value that was never in the document. So detection runs **deterministic
detectors first**, and those are strictly stronger than the NER they replace for
structured data:

| | v1 (spaCy NER) | v2 (deterministic first) |
| --- | --- | --- |
| Card numbers | Tagged if the model learned the shape | **Luhn checked** — an order number is not a card |
| Social Security numbers | Pattern-shaped | Structurally validated — area ≠ `000`/`666` |
| Account numbers | `ID` label, context-free | Only when *labelled* as an account |
| Dates of birth | `DATE`, indistinguishable from an invoice date | Only when preceded by `DOB` / `born` |
| API keys, IBANs | Not in the label set | Recognized by shape |

The model is then asked only what the detectors cannot settle, once per chunk —
and its answers are **located, never trusted**. It returns text it claims to have
seen; the application finds that text in the source itself and discards anything
it cannot locate. A model that paraphrases or invents a plausible value cannot
inject it into your document.

A value judged sensitive once is expanded to its other occurrences by local
string search. Seventeen mentions of a name cost one model call, not seventeen —
and cannot come back with a different answer the second time.

### What this version makes better

| | v1 | v2 |
| --- | --- | --- |
| **Formats** | PDF | PDF, DOCX, XLSX, PPTX, EML, CSV, TSV, TXT, RTF, images |
| **Fidelity** | Document rebuilt as plain text | Format-native: DOCX edited in place byte-identically, XLSX cells rewritten, only redacted PDF pages rasterized |
| **Who decides** | High / Med / Low, applied globally | Every suggestion accepted or rejected individually; nothing is removed that a person did not accept |
| **Manual control** | None | Click a word, drag a region, redact a cell/row/column, apply a rule everywhere |
| **Detection** | Fixed NER labels | Validated patterns + contextual model pass + local expansion |
| **Proof** | Trusted by construction | Every export re-opened and read adversarially; a surviving value **fails the export** |
| **Processing** | In-request, Socket.io | Durable workflow — retryable steps, resumable stream, a timeout costs a retry not the upload |
| **At rest** | Files on disk in the container | Per-document AES-256-GCM, TTL, scheduled purge of every artifact |
| **Access** | Path-based | Session ownership on every read; signed, short-lived, checksum-verified downloads |

The two additions that matter most are not in the detection layer at all.

**Human review.** Detection produces *suggestions*; only an accepted suggestion
reaches the exporter. This is the difference between a tool that redacts for you
and a tool you redact with — and it is what makes a wrong suggestion a
non-event instead of a data loss.

**Verification as a gate.** v1 was correct by construction: rebuild from text and
the old text is necessarily gone. v2 preserves the original document, which means
that guarantee has to be *earned* rather than assumed. So every export is
re-opened and read the way an adversary would — extracted PDF text, every OOXML
part, every sheet including hidden ones — and refused if an accepted value
survived. `tests/security.test.ts` runs twenty-one such recovery attempts against
produced artifacts, all of which must fail.

## How it works

Four layers, kept deliberately separate:

| Layer | What it is | Where |
| --- | --- | --- |
| **A. Source** | The uploaded file. Never mutated. | Blob storage, AES-256-GCM sealed |
| **B. Normalized** | Pages, spans with geometry, runs, sheets, regions | `lib/documents/*`, `types/document.ts` |
| **C. Redactions** | The record of what should be removed | `types/redaction.ts`, `lib/redaction/*` |
| **D. Output** | A new document generated from A + accepted C | `lib/redaction/export.ts` |

```
upload (browser → Blob)
  → ingest: sniff, checksum, seal, delete plaintext
  → extract: pages, spans, geometry
  → normalize: encrypted model artifact
  → detect: regex first, model for context only
  → review: accept / reject / manual / global rules
  → export: remove, verify, checksum, signed download
  → report: counts, styles and both checksums, as a second artifact
```

### Redaction is removal, not concealment

- **PDF** — a page with accepted redactions is rendered to pixels with the boxes
  burned in and rebuilt from that raster. There is no way to paint over text in
  a PDF and have it be gone. Pages without redactions are copied through and
  keep their selectable text. Scanned pages are read with OCR so they are
  reviewable like any other.
- **DOCX** — the text nodes that carry the characters are edited in place, so
  styles, numbering and relationships survive byte-identical. Headers, footers,
  footnotes and comments are extracted and reviewable, not merely swept.
- **XLSX** — cells are rewritten, and any formula still referencing a redacted
  address is dropped, because a cached result is a second copy of the value.
- **PPTX** — the same OOXML surgery, across the slides, the speaker notes, the
  layouts and the master. Three of those four are never on screen, and a deck
  that redacts only its slides ships the other three.
- **EML** — a message is a tree, not a body with a header on it. Every header,
  every text part, the visible text of every HTML part, quoted replies,
  attachment filenames and nested messages are all reviewable, and the export
  replaces byte ranges in the original so untouched parts come out identical.
  Attachment *bytes* are carried through unchanged — their filenames are
  redacted, their contents are not.
- **CSV / TSV** — parsed into a grid and rewritten cell by cell, so a value
  next to a comma inside a quoted field cannot shift every row after it.
- **TXT / RTF** — addressed by offsets into the source. RTF is parsed rather
  than searched, because a word processor splits a value across formatting
  groups and the string is often not in the file at all.
- **Images** — pixels are replaced and the file re-encoded. EXIF and GPS go too.

Each of these is argued through in [docs/pipelines.md](docs/pipelines.md),
which also carries the table of what each format's redaction model is and how
each is verified.

Every export is then re-opened and read the way an adversary would. A surviving
value fails the export rather than shipping (`lib/redaction/validation.ts`).

### Batches

Several files at once become a batch: one upload, one review pass, and one
archive at the end. The half that matters is not the upload — it is that a
decision made once is not made again on the next file. "This recurring name is a
colleague, not a subject" is answered in the document where it came up and
carried to the others, including the ones still being analyzed when it was
answered.

A batch owns decisions, not processing. Each document keeps its own run, its own
quota accounting, its own failure and its own expiry, so one document failing
leaves the rest exactly where they were — and the batch export delivers every
document that succeeded, naming the ones it could not include and why.

### Presets, and the one thing they must not say

A preset is a named set of detectors and categories — "Names and contact
details", "Payment and account numbers", "Credentials and keys" — chosen at
upload. It changes **what is looked for** and nothing else.

That sentence is the whole design. A preset called "HIPAA" that somebody applies
and then believes they have a compliant document is a worse outcome than having
no presets at all: it turns a tool that helps into one that misleads, on exactly
the question where being misled is most expensive. So presets are named for what
they search for, never for what they achieve, and the rule is enforced rather
than documented — a preset whose id, label or description contains a
regulation's name or a compliance claim fails validation at import
(`lib/redaction/presets.ts`).

Presets are data (`lib/redaction/presets/presets.json`), so changing what one
covers is a reviewable diff. A narrowed search is carried forward everywhere it
matters: the caveat sits under the chooser, the editor says which preset the
document was analyzed with, and the export report records it — because a short
list of removals means either a clean document or a narrow search, and those are
not the same thing.

### The export report

Every export produces a second artifact, downloadable beside the file: what was
removed by category and count, how each removal was applied — solid removal and
blur are not the same guarantee and the record says which — what the reviewer
rejected or never decided, and both checksums, so a third party can tie the
statement to a specific source and a specific output.

It carries counts and never content. A report that lists what was removed,
verbatim, is a leak with a covering letter, so the report is verified before it
is stored the same way the document is (`lib/redaction/report.ts`), and `pnpm
smoke` reads the delivered bytes and fails if a redacted value appears in them.

### Cost discipline

Deterministic detectors run first: email, phone, Luhn-checked cards,
structurally valid SSNs, IBANs, credentials, and label-gated dates and account
numbers. The model is asked only the contextual question, once per chunk. A
value judged sensitive once is expanded to all its occurrences by local search —
occurrence 2..n costs a string scan, not a request.

## Running it

Two supported setups. `pnpm setup` asks which you want and writes a working
`.env`; everything below is what it does, in case you would rather do it by
hand.

```bash
pnpm install
pnpm setup
```

It asks five things: how to run it, **who can reach it**, which services, what
the limits should be, and whether to keep the secrets already in your `.env`.
The middle two are the ones worth slowing down for.

*Who can reach it* is a separate question from which services you use, because
they are separate facts — a self-hosted instance on Neon is still your instance
and gets your allowances. Answer "just me" and there are no daily quotas at
all; answer "public and shared" and one visitor's workbook stops being
everyone's budget.

*Limits* covers the four groups that decide what this instance will accept:
daily quotas, rate limits, email parser limits, and how far an email's
attachments are expanded into documents of their own. Every default it prints
is read from the code that enforces it, so what you see is what is in force,
and everything you leave alone is written into `.env` as a commented line — so
the file says what the default is rather than leaving it to be discovered.

```bash
pnpm setup --local --defaults --yes   # no questions: local, profile defaults
pnpm setup --public                   # a shared instance: strict limits
pnpm setup --help                     # every flag
```

Re-running it is safe. It backs up the previous `.env`, and it offers to reuse
the secrets and keys already in it — which matters more than it sounds:
documents are sealed with per-document keys wrapped by `ENCRYPTION_KEY`, so a
new one does not reset anything, it makes everything already stored permanently
unreadable.

### Fully local — no accounts, nothing leaves your machine

Postgres and MinIO run in Docker, OCR runs through Tesseract, and no external
service is involved at any point.

**Prerequisites:** Node 22+, pnpm 11+, Docker.

```bash
git clone <this repo> && cd Anonify2.0
pnpm install
pnpm setup --local      # or just `pnpm setup` and choose; generates the secrets
docker compose up -d    # Postgres, MinIO, migrations, then Anonify itself
                        # http://localhost:3000
```

`docker compose up -d` runs the whole application. The app image is built from
this repo, the schema is applied before the app starts, and nothing needs to be
installed on the host beyond Docker itself — `pnpm install` and `pnpm setup` are
there to write `.env`, which is where the encryption key and the fingerprint
secret come from.

**To develop against those services with the app on the host**, start only the
dependencies so port 3000 stays free:

```bash
docker compose up -d postgres minio minio-init
pnpm db:migrate         # apply the schema
pnpm ocr:warm           # optional: fetch the OCR model now rather than later
pnpm dev                # http://localhost:3000
```

Tesseract downloads a ~5 MB English model the first time it reads a scanned
document, cached in `.cache/tesseract` (gitignored). `pnpm ocr:warm` fetches it
during setup instead, so the wait lands at a moment when waiting is expected.
Set `TESSERACT_CACHE_PATH` to a mounted volume if you run the app in a
container.

What `docker compose up -d` starts:

| Service | Port | Credentials | Purpose |
| --- | --- | --- | --- |
| `app` | 3000 | — | Anonify, built from this repo |
| Postgres 17 | 5432 | `anonify` / `anonify` | The database, in place of Neon |
| MinIO | 9000 (API), 9001 (console) | `anonify` / `anonify-dev-secret` | S3-compatible storage, in place of Vercel Blob |
| `minio-init` | — | — | Creates the `anonify` bucket, then exits |
| `migrate` | — | — | Applies migrations and the workflow schema, then exits |
| `scheduler` | — | — | Opt-in expiry sweep; see [Scheduled cleanup](#scheduled-cleanup) |

Every published port binds to `127.0.0.1` only, and the data lives in named
volumes across restarts. The credentials are development defaults — do not reuse
them anywhere reachable from outside your machine. If something on your machine
already holds one of these ports, set `APP_PORT`, `POSTGRES_PORT`, `MINIO_PORT`
or `MINIO_CONSOLE_PORT` in `.env`; the addresses used inside the compose network
are fixed and unaffected.

The app starts only after `migrate` exits successfully, so a fresh `up` never
serves against a schema that has not been applied. The container image is a
Next.js standalone build on `node:22-slim` — Debian rather than Alpine, because
sharp, `@napi-rs/canvas` and the pdf.js renderer all ship native binaries.

Durable runs need somewhere to live. On Vercel that is provided; in the
container it is Postgres, through `@workflow/world-postgres`, and
`instrumentation.ts` starts the worker that polls for jobs. Without that worker
a self-hosted install would accept uploads and never process them.

The resulting configuration:

```env
ANONIFY_PROFILE=self-hosted
DATABASE_URL=postgresql://anonify:anonify@localhost:5432/anonify
DATABASE_DRIVER=postgres
STORAGE_DRIVER=s3
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=anonify
S3_ACCESS_KEY_ID=anonify
S3_SECRET_ACCESS_KEY=anonify-dev-secret
OCR_PROVIDER=tesseract
ENCRYPTION_KEY=...       # generated by pnpm setup
FINGERPRINT_SECRET=...   # generated by pnpm setup
```

**Without even Docker.** Leave `STORAGE_DRIVER` unset and uploads go to
`.anonify-storage/` on disk. You still need a Postgres somewhere, because the
redaction record lives in it.

**AI detection is optional.** With no `AI_GATEWAY_API_KEY`, pattern detection,
manual redaction, global rules and export all work; only the contextual model
pass is skipped.

### Demo-compatible — the same services as the hosted demo

**Prerequisites:** Node 22+, pnpm 11+, and accounts for the services below.

```bash
pnpm install
pnpm setup --demo       # or just `pnpm setup` and choose
# fill in the three keys it lists
pnpm db:migrate
pnpm dev
```

| Variable | Service | Needed for |
| --- | --- | --- |
| `DATABASE_URL` | [Neon](https://neon.tech) | The database. Use the pooled string. |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob | Storage. The browser uploads directly to it. |
| `MISTRAL_API_KEY` | [Mistral](https://console.mistral.ai) | OCR for scanned documents. |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway | Optional — the contextual detection pass. |
| `CRON_SECRET` | your host | Gates the expiry sweep. |

`ANONIFY_PROFILE=demo` selects the restrictive rate limits the shared demo runs
with.

### What is configurable, and what it defaults to

Every backend is chosen by configuration and inferred when unset, so a fresh
clone works before anything is decided.

| | Options | Default |
| --- | --- | --- |
| `DATABASE_DRIVER` | `postgres`, `neon` | Inferred from the connection string |
| `STORAGE_DRIVER` | `s3`, `vercel-blob`, `local` | Inferred from what is configured |
| `OCR_PROVIDER` | `tesseract`, `mistral` | `tesseract` — local, no account |
| `ANONIFY_PROFILE` | `self-hosted`, `demo` | `self-hosted` |

Reads pick their driver from the stored key rather than the current setting, so
changing backends does not orphan documents that are already stored.

A note on the OCR choice: Tesseract locates text per **word**, Mistral per
**block** — roughly a paragraph. Both are real geometry, but a redaction over a
block covers the whole block, because a proportional slice of a wrapped
paragraph would be a rectangle in the wrong place. Mistral reads difficult scans
better; Tesseract redacts more precisely and needs no account.

### Rate limits

Defaults differ by profile — the shared demo is strict, a self-hosted install is
not — and can be changed without touching source:

```bash
pnpm rate-limit show                            # what is in force, and from where
pnpm rate-limit set --requests 500 --window 60  # all limits
pnpm rate-limit set upload --requests 20 --window 60
pnpm rate-limit reset
```

Three layers, later winning: profile defaults →
`ANONIFY_RATE_LIMIT_<NAME>=100/60` → the CLI, which writes to the database and
takes effect without a restart.

### Daily quotas

Separate from rate limits, and counted per identity per UTC day: pages, cells,
images and uploads. They exist so one anonymous visitor cannot spend the shared
demo's whole budget.

**A self-hosted install has none.** There is nobody to ration against, and a
quota here is indistinguishable from the software being broken — it arrives as
"processing failed" on a spreadsheet that is in no way unusual. If you are
running something shared, set them explicitly:

```bash
ANONIFY_QUOTA_XLSX_CELLS=500000   # 0, or unset on self-hosted, means unlimited
ANONIFY_QUOTA_PDF_PAGES=200
ANONIFY_QUOTA_DOCX_PAGES=200
ANONIFY_QUOTA_TEXT_PAGES=400
ANONIFY_QUOTA_PPTX_SLIDES=200
ANONIFY_QUOTA_EMAIL_KILOBYTES=4096
ANONIFY_QUOTA_IMAGES=100
ANONIFY_QUOTA_UPLOADS=200
```

The units are not all the same shape, because the work is not:

| Quota | Unit | Formats |
| --- | --- | --- |
| `PDF_PAGES` / `DOCX_PAGES` | pages | PDF, DOCX |
| `XLSX_CELLS` | filled cells | XLSX, CSV, TSV |
| `TEXT_PAGES` | pages of extracted text | TXT, RTF |
| `PPTX_SLIDES` | slides | PPTX |
| `EMAIL_KILOBYTES` | KiB of decoded text: headers, every body, every nested message | EML |
| `IMAGES` / `UPLOADS` | one each | all |

An email is charged by the text it actually decoded rather than as a page,
because counting it as a page would charge a one-line reply the same as a
forwarded thread. A deck is charged by its slides; its notes, layouts and
masters are processed with the slide they belong to.

A message additionally has parser limits of its own — MIME depth, part count,
decoded text, header size, attachment count, nesting — which are independent of
the upload ceiling on purpose. Raising the size a file may be must never be the
same decision as allowing unlimited complexity. See `.env.example`.

Spreadsheet cells are counted as cells that hold something, not as the area of
the used range — a sheet with three filled columns and one stray value out in
column AN is charged for what it contains, not for the blanks between.

### Expiring documents when you self-host

Documents are temporary, which is only true if something is actually deleting
them. On Vercel that is the cron entry in `vercel.json`. **Nothing outside
Vercel reads that file**, so a self-hosted install needs its own schedule.

Either run the sweep directly — no server and no secret needed, so this suits
cron, a systemd timer or Task Scheduler:

```bash
pnpm cleanup     # one pass: mark expired, delete documents, prune rate limits
```

```cron
*/15 * * * *  cd /srv/anonify && pnpm cleanup
```

Or let Compose call the endpoint for you:

```bash
docker compose --profile scheduler up -d
```

It is opt-in because a short-lived local install has little worth sweeping. Tune
with `CLEANUP_INTERVAL_SECONDS` (default 900) and `ANONIFY_URL` (default
`http://app:3000` — point it at `http://host.docker.internal:3000` if you run
the app on the host).

Set `CRON_SECRET` before you do. The container image runs as production, where
the cleanup endpoint refuses any request that does not carry it, so without one
the scheduler starts, 401s every cycle, and documents outlive their retention
window. It says so — once at startup and again on every refusal — rather than
logging a status code nobody reads. `pnpm setup` generates it.

It is a warning rather than a hard failure because pointing `ANONIFY_URL` at a
development server on the host is legitimate: that server has no secret of its
own, and the endpoint accepts an unauthenticated sweep outside production.

Whichever you choose, the sweep deletes the source, the normalized model, every
export and the database row — and is idempotent, so a failed run is retried
rather than leaving bytes nothing is tracking.

### Database changes

Migrations are the canonical workflow, and CI applies them to an empty database
on every push:

```bash
pnpm db:migrate         # create and apply a migration in development
pnpm db:migrate:deploy  # apply existing migrations (CI, production)
pnpm db:push            # schema straight to the database, for scratch work only
```

## Commands

```bash
pnpm setup             # choose a setup, set the limits, write .env
pnpm setup --help      # its flags, for a scripted install
pnpm dev               # development server
pnpm build             # production build
pnpm test              # unit and adversarial suites
pnpm test:db           # the Postgres-backed suites (needs TEST_DATABASE_URL)
pnpm typecheck         # next typegen && tsc --noEmit
pnpm lint              # eslint
pnpm db:migrate        # create and apply a migration
pnpm db:migrate:deploy # apply existing migrations
pnpm rate-limit show   # inspect the limits in force
pnpm ocr:warm          # pre-download the Tesseract model
pnpm cleanup           # run the expiry sweep once
pnpm smoke             # every format, against a running instance
pnpm smoke --only=eml  # or one of them
pnpm bench             # extraction and export, timed over large documents
```

Node 22+ and pnpm 11+ are required and enforced — `engines` plus
`engine-strict`, so an unsupported runtime fails at install with a clear message
rather than somewhere confusing later.

## Tests worth knowing about

- `tests/security.test.ts` — takes each exported artifact and tries to get the
  sensitive value back out: PDF text extraction, raw byte scans with glyph
  spacing stripped, annotation objects, every OOXML part, hidden sheets and
  rows, cached formula results, the shared string table, sampled pixels, EXIF.
- `tests/adversarial.test.ts` — one pass over every format through the real
  export path, asserting three things each: the accepted value is gone read in
  that format's own terms, a *rejected* value is still there (a redactor that
  empties the file passes the first test and is useless), and the artifact
  still opens as what it claims to be.
- `tests/export.test.ts` — end-to-end redaction per format, including that a
  *suggestion* the user never accepted is still present in the output.
- `tests/integration/` — the database-backed suites. Expiry cleanup's ordering
  guarantee (storage first, the row second, and only if the storage actually
  went) and quota accounting's atomicity and charge-once behaviour are
  properties of the row rather than of the function, and a fake would agree
  with whatever the code did.
- `tests/detectors.test.ts` — that an order number is not reported as a card,
  and a date is only a birth date when it is labelled as one.
- `scripts/smoke.ts` — not a unit test: it drives a *running* instance over
  HTTP, uploading a synthetic document of each supported format and opening the
  downloaded export the way an adversary would — reparsing a CSV as a grid,
  reparsing a message with an independent MIME library, unzipping a deck and
  reading the notes and the master, sampling an image's pixels. CI runs it against the compose stack on
  every pull request, which is how the container's assembly gets checked at all
  — a missing native library or an unreachable workflow world passes every test
  above and fails here.

## Contributing

The project is meant to be cloned, read and changed.
[CONTRIBUTING.md](CONTRIBUTING.md) covers the invariants that must not break, an
audit of what is currently half-wired, and what the next phase of work is.

The standing ask: **benchmark it**. The architecture claims that deterministic
detection plus a narrow model pass costs far fewer tokens than sending documents
to a model, at comparable quality. Nobody has measured that, and it could be
wrong. CONTRIBUTING specifies what to measure and what to submit.

There are no accounts and no auth, deliberately: you run this against your own
database and your own storage. The hosted demo is anonymous so people can try
the tool without setting it up.

Found a way to get a redacted value back out of an exported file? That is the
one thing here worth reporting privately first — [SECURITY.md](SECURITY.md) says
how, and what does and does not count.

## Security notes

- Per-document random data keys, sealed under a server-held master key.
  AES-256-GCM throughout. SHA-256 is used for integrity only — it is not
  encryption, and nothing here pretends otherwise.
- Ownership comes from a server-issued session id; quotas and rate limits use a
  coarsened network hash as well, so clearing a cookie does not reset the demo
  allowance. Only salted hashes are stored. No browser fingerprinting, and no
  MAC addresses — a browser cannot expose one.
- Blob URLs are never handed to the client. Downloads go through a signed,
  short-lived, ownership-checked route.
- Documents expire (1h / 6h / 24h / 3 days) and a scheduled sweep deletes the
  source, the normalized model, every export and every row. Retention can be
  extended, but the new expiry is computed from creation and capped at 72 hours,
  so renewing repeatedly converges on the ceiling rather than moving it.
- Logs carry ids, stages, durations and error categories. Never document
  content, never prompts, never keys.

## License

[Apache-2.0](LICENSE). Use it, fork it, run it commercially, deploy it inside a
company — the patent grant is there so nobody's legal team has to think about it.

Section 7 is worth reading rather than skimming, though: this software comes with
no warranty, including no warranty that any particular value was removed from any
particular file. That is not boilerplate here. Anonify verifies every export
against the values you accepted and refuses to deliver one that fails — but
verification can only look for what it was told to look for, and the decision
about what to accept was yours. Check the file before you send it.
