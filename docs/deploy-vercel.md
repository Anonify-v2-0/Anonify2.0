# Deploying to Vercel (Hobby)

Anonify runs on Vercel's Hobby plan. This document is the setup, and — more
usefully — the list of places where Hobby's limits and the way this app works
meet, so that a deployment that is about to break does so on this page rather
than on somebody's upload.

Nothing here is required for the container or the local install; see the README
for those. The code changes this document describes are already in the repo.

---

## 1. What Hobby actually constrains

Five limits matter, and each one touched something in this codebase.

| Limit | Hobby's value | Where it bites |
| --- | --- | --- |
| Function duration | **300s**, default *and* maximum | The SSE progress streams asked for 900s |
| Cron frequency | **once per day**, more often fails the deploy | The expiry sweep asked for every 15 minutes |
| Response body | **4.5 MB** buffered | Every document download and the PDF preview |
| Function bundle | **250 MB** uncompressed | The workflow step function, with OCR, reaches ~228 MB |
| Memory / CPU | **2 GB / 1 vCPU**, not configurable | Tesseract on a multi-page scan |

The first two would have failed the deployment outright. The third fails per
request, on any document over 4.5 MB, which is most real ones. The fourth fails
the build when it trips. The fifth does not fail at all — it just takes longer
than the 300s the step is allowed.

---

## 2. Set up

### 2.1 Services

Three accounts, all with free tiers.

| Service | Gives you | Variable |
| --- | --- | --- |
| [Neon](https://neon.tech) | Postgres | `DATABASE_URL` — use the **pooled** string |
| Vercel Blob | Document storage | `BLOB_READ_WRITE_TOKEN` |
| [Mistral](https://console.mistral.ai) | OCR | `MISTRAL_API_KEY` |

Create the Blob store from the Vercel dashboard: **Storage → Create → Blob**,
then connect it to the project. Connecting sets `BLOB_READ_WRITE_TOKEN` for you.

Vercel AI Gateway (`AI_GATEWAY_API_KEY`) is optional. Without it, pattern
detection, manual redaction, rules and export all still work; only the
contextual model pass is skipped.

### 2.2 Generate the two secrets

Both must decode to 32 bytes:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # FINGERPRINT_SECRET
```

`ENCRYPTION_KEY` is the master key for per-document envelope encryption.
**Losing it makes every stored document unreadable** — there is no recovery, by
design. `instrumentation.ts` parses and length-checks it at boot and refuses to
start on a malformed one, so a bad key fails the deployment rather than the
first upload.

`CRON_SECRET` gates the expiry sweep so it cannot be triggered from outside. Any
long random string works; generate it the same way.

### 2.3 Environment variables

Set these in **Settings → Environment Variables**, for Production and Preview.

```
DATABASE_URL           postgresql://…            # Neon, pooled
BLOB_READ_WRITE_TOKEN  vercel_blob_rw_…          # set by connecting the store
ENCRYPTION_KEY         <64 hex chars>
FINGERPRINT_SECRET     <64 hex chars>
CRON_SECRET            <random>

OCR_PROVIDER           mistral                   # see §3.1 — do not leave default
MISTRAL_API_KEY        <key>

ANONIFY_PROFILE        demo                      # see §3.4
AI_GATEWAY_API_KEY     <key>                     # optional
```

Leave `WORKFLOW_TARGET_WORLD` and `WORKFLOW_POSTGRES_URL` **unset**. They select
the self-hosted Postgres world and start a polling worker; on Vercel the durable
backend is supplied by the platform, and `instrumentation.ts` skips its own
startup when they are absent. Setting them here would start a worker in a
serverless function that does not live long enough to poll.

`OCR_PROVIDER` must be set at **build** time, not just at run time — see §3.1.
Vercel exposes environment variables to the build by default, so setting it in
the dashboard is enough.

### 2.4 Project settings

- **Build command** — the default `pnpm build` is correct. `postinstall` runs
  `prisma generate` and copies the PDF worker.
- **Node version** — 22 or later (`package.json` requires it).
- **Fluid compute** — leave enabled. It is on by default for new projects, and
  the 300s maximum duration depends on it; without it Hobby caps at 60s, which
  is not enough for a scanned PDF.
- **Region** — Hobby runs in one region. Put it near your Neon database;
  `iad1` is the default for both.

### 2.5 Migrate the database

Vercel does not run migrations. From your machine, with `DATABASE_URL` pointing
at the production database:

```bash
pnpm db:migrate:deploy
```

Run this before the first deployment serves traffic, and after any migration.

### 2.6 Deploy

```bash
vercel --prod
```

Then confirm the sweep is authorized — it should answer with counts, not a 401:

```bash
curl -H "authorization: Bearer $CRON_SECRET" https://<your-app>/api/cron/cleanup
```

---

## 3. What changed for Vercel, and why

### 3.1 The workflow step function is where the work happens

The largest correctness problem, and the least obvious.

`next.config.ts` names assets that file tracing cannot find on its own — pdfjs's
fonts and CMaps, the Tesseract worker tree, libvips. That list used to be keyed
on `/api/**`, which is right for a container, where `output: "standalone"`
merges every route's trace into one server directory.

On Vercel each route is its own function, and **the `/api/**` routes are not
where documents are processed**. The Workflow SDK generates a step handler at
`app/.well-known/workflow/v1/step/route.js`, and that function is what runs
extraction, rasterisation and OCR. The `/api` routes only start runs and read
their results. So the assets were being shipped to every function *except* the
one that opens them — visible only as a workflow step exhausting its retries
against a missing font, or a Tesseract worker that cannot find its WASM core.

The includes are now keyed on both, and split by what each needs.

**This is also why `OCR_PROVIDER` matters at build time.** Tesseract's worker
tree and core are ~145 MB, which puts the step function at ~228 MB against a
250 MB ceiling — it fits, but with nothing spare. `next.config.ts` therefore
skips those assets when `OCR_PROVIDER` names a hosted provider, taking the step
function to ~87 MB:

| Build | Step function |
| --- | --- |
| `OCR_PROVIDER` unset or `tesseract` | ~228 MB |
| `OCR_PROVIDER=mistral` | ~87 MB |

This is safe because provider selection refuses rather than falls back: an
`OCR_PROVIDER` that cannot run raises at selection, so a build made without the
Tesseract assets can never quietly try to use them.

Set `OCR_PROVIDER=mistral` on Vercel. Besides the size, Hobby gives 1 vCPU, and
Tesseract on one core does not finish a multi-page scan inside 300s.

If a bundle does exceed 250 MB, set `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` as a
project environment variable — Vercel then allows up to 5 GB for functions that
exceed the standard limit. Prefer fixing the bundle.

### 3.2 Downloads are streamed, not buffered

Vercel refuses a buffered response body over 4.5 MB with
`FUNCTION_PAYLOAD_TOO_LARGE`, before a byte reaches the browser. Three routes
returned whole documents that way: the export download, the batch ZIP, and
`/api/documents/[id]/source`, which is what the workspace previewer loads — so a
12 MB PDF failed to display at all.

They now return a chunked stream via `fileResponse()` in `lib/api/http.ts`,
which has no such cap. `content-length` is deliberately omitted: setting it
alongside a stream makes some intermediaries treat the response as buffered
again. The cost is a progress bar the browser cannot fill.

The bytes are still decrypted and checksummed in full before anything is sent —
this app verifies what it serves, and cannot honestly stream something it has to
hash first. What changed is the response, not the pipeline.

### 3.3 Durations and the cron schedule

`vercel.json` and the two SSE routes asked for 900s. Hobby's maximum is 300s, so
they are now 300. Both streams are resumable — a client reconnects with the
index of the last event it saw — so being cut at the limit costs a reconnect and
no work.

The cron went from `*/15 * * * *` to `0 4 * * *`. This is not a preference:
Hobby **fails the deployment** on any expression that would run more than once a
day. Hobby's scheduler is also only accurate to the hour, so `0 4 * * *` fires
somewhere between 04:00 and 04:59 UTC.

That matters more than it looks. `/api/cron/cleanup` does two jobs: it deletes
expired documents, and it admits any document left queued behind a slot nothing
freed. Once a day means a document can outlive its stated TTL by most of a day —
which breaks the retention promise the UI makes, even though nothing errored.

So `.github/workflows/sweep.yml` calls the same endpoint every 15 minutes from
GitHub Actions, free. Add two repository secrets to enable it:

- `SWEEP_URL` — `https://<your-app>/api/cron/cleanup`
- `CRON_SECRET` — the same value as the deployment's

Without both, the job exits quietly. The work is idempotent, so the daily Vercel
cron and the 15-minute sweep running together is harmless. On Pro, delete the
workflow and raise the schedule in `vercel.json` instead.

### 3.4 Storage cannot fall back to the filesystem

`selectStorageDriver()` fell back to the local filesystem when nothing was
configured — right for a fresh clone, a trap on Vercel, where the filesystem is
read-only outside `/tmp` and per-instance. Worse, the local driver routes the
browser's bytes through this app's own upload route, where Vercel caps a request
body at 4.5 MB, so the symptom was a 413 on a 12 MB upload pointing nowhere near
the missing configuration.

It now raises on Vercel, naming the variable to set. Vercel Blob is the path
that works, because the browser uploads to it directly and never sends the file
through a function at all.

### 3.5 Set `ANONIFY_PROFILE=demo`

Not a fix, a fit. The profile selects rate limits, daily quotas and concurrency
(`lib/config/profile.ts`). `demo` allows 3 documents processing and 2 exporting
at once per visitor; `self-hosted` allows 6 and 4, on the assumption that the
machine is yours.

On 2 GB and 1 vCPU, `demo` is the honest description of a Hobby deployment.
Extraction holds a document in memory, OCR holds a rasterised page, and export
re-rasterises every redacted page — the heaviest thing this codebase does.
Override individually with `ANONIFY_BATCH_PROCESSING`, `ANONIFY_BATCH_EXPORTING`
and `ANONIFY_BATCH_MAX_FILES` if you disagree.

---

## 4. Known limits of a Hobby deployment

Things that work, but not the way the container does. None are bugs.

- **Uploads over ~20 MB may not finish processing.** `MAX_UPLOAD_BYTES` is
  50 MiB, and the upload itself is fine — it goes straight to Blob. What is
  bounded is the step: 2 GB and one core, 300s per step. A large scanned PDF can
  exhaust that. The run fails cleanly and the document is marked failed; it does
  not corrupt anything. Lower the ceiling in `lib/config.ts` if you would rather
  refuse those uploads than have them fail late.

- **Blob storage is 1 GB on the Hobby tier**, and this app stores the source, the
  normalized model and each export. The sweep deleting expired documents is what
  keeps that bounded, which is the other reason §3.3 matters.

- **Workflow runs are retained for 1 day** after completion on Hobby (7 on Pro).
  Runs stay inspectable in the dashboard for that long; the documents themselves
  are governed by their own TTL, not this.

- **Hobby includes 50,000 workflow events and 1 GB of workflow data written per
  month.** A document's run makes 11 step calls on the success path, and a step
  costs three events (`step_created`, `step_started`, `step_completed`) plus one
  more per retry — so roughly 35–40 events per document, and an allowance of
  somewhere over a thousand documents a month. Batch exports are their own runs
  on top of that.

- **Cold starts are slow** on the step function — it is ~87 MB and loads native
  bindings. The first document after an idle period takes noticeably longer.
