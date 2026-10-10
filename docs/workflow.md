# The processing workflow

`lib/workflows/process-document.ts`

Processing runs on the Workflow SDK as a durable run rather than inside a
request. This document explains what that buys, what each step does, and why the
boundaries are where they are.

---

## 1. Why not a request

The obvious implementation is a long POST handler. It fails in three ways that
matter here:

- **A timeout loses the work.** Extraction plus OCR plus a model pass over a
  40-page PDF can exceed any sane request budget. Retrying means starting over.
- **A background promise loses it silently.** Kick the work off and return, and a
  cold start or an instance recycling ends it with nothing written down.
- **Partial failure is unrecoverable.** If analysis fails after extraction
  succeeded, a request-scoped implementation has no way to resume; it re-extracts
  or gives up.

A durable run fixes all three. Each step's result is persisted, so a failure
resumes from the last completed step. A step that throws is retried on its own.
`FatalError` marks the failures that retrying cannot fix — an unsupported file
type does not become supported on the third attempt.

---

## 2. The orchestrator

The `"use workflow"` function only sequences. It runs in a sandbox without Node
built-ins, so it holds no logic beyond ordering and error handling:

```ts
export async function processDocument(documentId: string) {
  "use workflow"

  try {
    await publishStatus(documentId, "queued",      "document.queued")
    await publishStatus(documentId, "extracting",  "document.extracting")
    await ingestUpload(documentId)

    await publishStatus(documentId, "normalizing", "document.normalizing")
    const { pageCount } = await extractAndNormalize(documentId)

    await publishStatus(documentId, "analyzing",   "document.ai.started")
    const { suggestions } = await analyze(documentId)

    await finish(documentId, pageCount, suggestions)
    return { documentId, status: "ready" }
  } catch (error) {
    await fail(documentId, message(error))
    return { documentId, status: "failed" }
  }
}
```

Everything real is a `"use step"` function with full Node access — file parsing,
crypto, database, model calls.

### Where the runs live

A durable run needs durable storage. On Vercel that backend is supplied by the
platform; anywhere else it has to be named. The container sets
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres` and keeps runs, steps and
streams in the same Postgres as everything else, and `instrumentation.ts` starts
the worker that polls for jobs.

Two details are easy to get wrong and both fail quietly:

- **The worker has to be started.** Without it a self-hosted install accepts
  uploads and never processes them — the run is created and nothing picks it up.
- **The world reads `WORKFLOW_POSTGRES_URL`, not `DATABASE_URL`,** and when that
  is unset it defaults to `postgres://world:world@localhost:5432/world` rather
  than failing. `instrumentation.ts` therefore defaults it from `DATABASE_URL`,
  so one connection string configures both.
- **Only a process that runs steps starts the worker.** With `ANONIFY_ROLE=web`
  a process starts runs and reads their streams, and its runner never starts;
  with `worker` or `all` it does, and delivers each step through a loopback
  relay that proxy.ts checks for (#179). See
  [architecture.md §10](./architecture.md#10-process-roles).

### Startup sequence

`instrumentation.ts` runs `register()` once, before the server accepts traffic.
The order inside it is load-bearing in three ways the comments explain but the
docs did not:

- **Fail on the way up, not on the first document.** `ENCRYPTION_KEY` is read
  lazily, deep inside the pipeline, so a malformed one used to present as a
  workflow step exhausting its retries — by which point the upload had been
  accepted and the cause was several layers away from the message. `register()`
  calls `assertMasterKey()` from `lib/storage/encryption` to parse and length-
  check the key at boot and refuse to start if it is wrong. The reason it is
  there at all is an incident: a YAML config turned a 64-zero key into the
  integer `0`, which silently broke encryption, and the crypto test suite never
  caught it because every test mints its own key. The assertion exists to catch
  that class of misconfiguration at boot, in production, where no test runs.

- **The dynamic `import("@workflow/world-postgres")` is what makes the build
  trace it.** The world is chosen at runtime by `WORKFLOW_TARGET_WORLD` and
  loaded with a dynamic `require(targetWorld)` that no bundler can follow.
  Naming the package here, as a literal `import()` inside `register()`, is what
  puts it — and its Postgres driver — into the Next.js standalone build's
  traced dependencies. A contributor who moves this import into a helper file,
  wraps it behind a conditional, or "tidies it up" breaks the container build
  silently: the build succeeds, the package is not traced, and the worker
  starts and then cannot load its own world. The import is not there to be
  called; it is there to be seen by the bundler.

- **The startup log is a single structured line.** Once the world has started,
  `register()` emits exactly one record:

  ```json
  {"level":"info","context":"workflow.world","world":"@workflow/world-postgres","message":"workflow worker started"}
  ```

  The shape — `level`, `context`, `world`, `message` — is the one log consumers
  should expect from this process. It is the only place the chosen world is
  announced at startup, and a deployment that never emits it has not started
  the worker.

---

## 3. The steps

```mermaid
flowchart TD
    Q["publishStatus: queued"] --> ING["ingestUpload<br/>fetch, open, sniff, checksum, re-seal, delete the upload and its key"]
    ING --> ATT{"a message with<br/>attachments?"}
    ATT -- yes --> CH["expandAttachments<br/>each attachment becomes a document with its own run"]
    ATT -- no --> EX
    CH --> EX["extractAndNormalize<br/>re-verify the checksum, dispatch to the format pipeline,<br/>charge the allowance once"]
    EX --> AN["analyze<br/>detectors → contextual pass → expand<br/>every result written with status suggested"]
    AN --> FIN["finish<br/>terminal status, last event, stream closed"]
    ING -. throws .-> F["fail<br/>an error category in the log and a short message<br/>on the row — never the document's content"]
    EX -. throws .-> F
    AN -. throws .-> F
    FIN --> DONE(["status: ready"])
    F --> STOP(["status: failed"])
```

Each box is a `"use step"` function: retried on its own, its result persisted,
so a replay resumes at the first one that has not completed.

### `ingestUpload` — take ownership of the bytes

The browser uploaded straight to storage, so this is the first moment the
server sees the file. The body lives in `lib/documents/ingest.ts` (`runIngest`);
the step adds retry pacing.

1. Fetch the upload. When the row records `uploadFormat`, the browser sealed
   it, and it is opened with the single-use upload key as it streams (see
   [storage.md](./storage.md#sealed-uploads)). Nothing below this line knows
   it was sealed. A row without `uploadFormat` is a plaintext upload, read as
   it is.
2. Reject empty or oversized files. The ceiling is on the plaintext, so a
   sealed upload's stored size is first converted.
3. **Sniff the content.** The declared MIME type and the filename are hints; the
   magic bytes decide. A `.pdf` that is actually a zip is rejected rather than
   guessed at.
4. SHA-256 the bytes.
5. Seal under a fresh per-document data key; store as `source.bin`.
6. Delete the upload and null the wrapped upload key.

A sealed upload that does not open fails with `upload-unreadable`, and nothing
is stored as `source.bin`. That covers a failed tag, a truncated or reordered
envelope, the wrong key, path or chunk size, and plaintext where ciphertext was
promised. It is a verdict, not weather, so it is not retried.

The step is idempotent: on replay it sees `sourceBlobKey` already set and returns
early rather than re-encrypting under a second key and orphaning the first. If
the previous attempt died between recording the source and deleting the
upload, the replay finishes that cleanup.

### `expandAttachments` — a message with attachments becomes a batch

Between ingest and extraction: a message (`eml`) is parsed for its attachments,
and each one becomes a first-class document with its own run, its own
extraction and its own review. Every other kind falls straight through, and a
message with nothing expandable in it costs one parse.

Expansion runs here rather than at reservation — reservation happens before
the browser has uploaded anything, so there are no bytes to parse and the
declared MIME type is a guess — and before extraction, so the children are
already queued while the message itself is still being read: a reviewer
opening the batch sees the enclosures arriving rather than appearing at the
end.

A limit — the parser's or expansion's — is a verdict about this message, not
weather. Retrying reads the same bytes and reaches the same number, so it is
refused whole as `too-complex` (a partly expanded message would look complete
and would not be). Each child's run is started at most once, guarded on the
`workflowRunId` column rather than on the step replaying, so a retried step
cannot race the first run through the same rows.

### `extractAndNormalize` — one vocabulary from every format

Reads the sealed source back, **re-verifies the checksum** (storage that returns
different bytes than it was given is a problem worth catching before those bytes
are parsed), and dispatches to the format pipeline — see
[pipelines.md](./pipelines.md).

The normalized model is then sealed under the same document key and stored
outside the database. It contains the document's text, and text in a database
column is text in every backup and every query log.

This is also where the demo allowance is charged, because it is the first moment
the real cost is known: pages for a document, cells for a grid, slides for a
deck, kibibytes of decoded text for a message. Going over stops the pipeline —
it never deletes what the user uploaded.

The charge is **idempotent**, and it has to be. This step is retried on a
storage blip or a cold worker and re-extracts from scratch each time, while the
charge happens before the step returns, so a document that failed after
charging and succeeded on the next attempt used to be billed twice for one
upload. The fact of having charged is recorded in the document's own row, and a
retry reads it back before deciding. See `chargeDocumentUsage`.

### `analyze` — propose, never decide

Runs the detection pipeline in [ai-engine.md](./ai-engine.md), streaming progress
as it goes, and writes every result as a row with `status: "suggested"`.

For images it additionally runs a vision pass over the actual pixels, and for a
PDF over each page that paints an image (the first 20 of them). A PDF's pages
are rendered one at a time and sent to the model as each is drawn, up to
`ANONIFY_AI_CONCURRENCY` at once, so at most that many page images are held in
memory. Their suggestions are collected in page order however the calls finish.

For spreadsheets, a column the model judges sensitive is written as **one
column-level suggestion** rather than one per cell — because that is the decision
the reviewer wants to make, and because ten thousand rows should not become ten
thousand list items.

> The pipeline never marks its own findings accepted. There is no code path in
> which detection produces an `accepted` redaction.

### `finish` / `fail`

Set the terminal status, emit the last event, and close the stream. `fail`
records an error category in the log and a short message on the document —
never the document's content.

---

## 4. Streaming

Steps write newline-delimited JSON to the run's durable stream:

```ts
const writer = getWritable<string>().getWriter()
try {
  await writer.write(encodeStreamEvent(event))
} finally {
  writer.releaseLock()   // an unreleased lock keeps the request alive
}
```

`GET /api/documents/:id/stream` reads that stream, converts each line to an SSE
frame with its index, and serves it with a 15-minute duration. The route is
declared `supportsCancellation` so a client that navigates away tears the
invocation down rather than billing until the ceiling.

The client hook (`hooks/use-processing-stream.ts`) tracks the last index it
actually saw. On reconnect it asks for `startIndex = last + 1`, so a dropped
connection resumes rather than replaying the run or missing its middle.

Events carry ids, stages, counts and durations. They never carry document text —
the stream is a progress channel, not a data channel.

```mermaid
stateDiagram-v2
    [*] --> queued: document.queued
    queued --> extracting: document.extracting
    extracting --> normalizing: document.normalizing
    extracting --> expanded: document.expanded<br/>(a mailbox: it is the batch)
    normalizing --> analyzing: document.ai.started
    analyzing --> analyzing: document.ai.progress ×N
    analyzing --> ready: document.redaction.created<br/>then document.ready
    extracting --> failed: document.failed
    normalizing --> failed: document.failed
    analyzing --> failed: document.failed
    ready --> [*]
    expanded --> [*]
    failed --> [*]
```

`expanded` is the container's ending, and it is terminal. A mailbox expands
into one document per message and then has nothing left to do: no model to
normalize, no suggestions to analyze, no artifact to export. Running it through
the remaining stages would mean an extractor that does not exist, and finishing
it as `ready` would put it in the batch export as a document that could not be
exported. See `lib/documents/mbox/` and docs/pipelines.md.

### Event shapes

Each line on the stream is one JSON object (newline-delimited, then framed as
SSE by the route). Both shapes are deliberately small and serializable: never
document text, never extracted content, only what the UI needs to show
progress.

**`ProcessingStreamEvent`** (`lib/workflows/events.ts`) — what the processing
run writes:

```json
{
  "type": "document.ai.progress",
  "documentId": "doc_…",
  "at": "2026-09-05T12:00:00.000Z",
  "status": "analyzing",
  "progress": 70,
  "message": "Analyzing…",
  "payload": { "stage": "text", "completed": 3, "total": 8, "suggestions": 12 }
}
```

Only `type`, `documentId` and `at` are required; `status`, `progress`,
`message` and `payload` are optional and present only when the event has
something to say in them. `payload` is the only field that varies by `type`
— it carries the counts and stages the UI renders, and nothing else.

**`BatchExportStreamEvent`** (`lib/workflows/batch-export-events.ts`) — what
the batch export run writes. Each event is a whole snapshot rather than a
delta; a batch is a couple of dozen entries at most, and the saving from
sending differences is nothing next to a client that missed one and is now
quietly wrong:

```json
{
  "type": "export.progress",
  "at": "2026-09-05T12:00:00.000Z",
  "status": "running",
  "total": 8,
  "completed": 3,
  "exported": 2,
  "documents": [
    { "id": "doc_…", "name": "invoice.pdf", "state": "exported", "removed": 4 },
    { "id": "doc_…", "name": "notes.docx", "state": "skipped", "reason": "not-ready" }
  ],
  "error": null
}
```

`type` is `"export.progress"` while the run is moving and `"export.finished"`
on the last frame. Filenames are the only thing from the documents that
appears here, and the reviewer already knows them: never a redaction, a
category, or a count of what was found in any file.

`encodeStreamEvent` / `decodeStreamEvent` (and the batch equivalents) are the
pair that frame and parse these lines. `decode*` returns `null` on a blank or
unparseable line rather than throwing, so a malformed frame drops quietly
instead of tearing down a live stream.

---

## 5. Batch export

`lib/workflows/export-batch.ts`

Exporting a batch is the same work as exporting one document, a dozen times:
each file is redacted, verified against its own exported bytes and sealed. That
is minutes, which is longer than a request may live and much longer than a
person will sit in front of a modal, so it is a run rather than a response.

```
POST   /api/batches/:id/export        → creates a BatchExport row, starts the run, 202
GET    /api/batches/:id/export        → where the run has got to
DELETE /api/batches/:id/export        → stop it
GET    /api/batches/:id/export/stream → follow it, as server-sent events
```

The row is the record. Each document is one `"use step"`, so a step that dies is
retried on its own and the run resumes at the document it was on rather than
re-redacting the ones already done; each step writes its outcome to
`BatchExport.documents`, and the totals are recomputed from those states rather
than incremented, because a retried step would otherwise count twice.

**Retry pacing.** The SDK enqueues each retry immediately, which is close to no
retry at all against the failures that are actually transient — a provider
rate limit, a cold worker, a storage blip sees the same weather three times
inside a few hundred milliseconds. So a throwing step is rethrown through
`paced`, which delays the next attempt with exponential backoff:

```ts
const MAX_BACKOFF_MS = 30_000
function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempt - 1))
}
```

Doubling from a second, capped at 30 seconds so a stuck dependency cannot
park a run for half an hour. `FatalError` passes through `paced` untouched —
it exists to say retrying cannot help, and wrapping it would throw that away.
The processing pipeline uses the same pacing (see §3 and
`lib/workflows/process-document.ts`).

**Not the right altitude for a rate limit.** Step retry re-runs a *whole step* —
the decrypt, the rasterisation, every page already recognised — which is correct
for a storage blip and wrong for a metered provider. A rate limit is a
per-request condition, and re-running the same burst against a limit that exists
*because* of the burst is the one response that reliably makes it worse. So
requests to a service this install does not own go through
`lib/services/throttle.ts` instead: paced under `ANONIFY_OCR_*` /
`ANONIFY_AI_*` so a known limit is not hit, and retried per request — with
jitter, honouring `Retry-After` — when one is hit anyway. The step-level pacing
above still covers everything around them: storage, the database, rasterizing
pages for the vision pass.

Nothing about the browser is load-bearing. Closing the modal, reloading, or
opening the batch on another device reads the same row, which is why the button
can show `Exporting 3 of 8` while the window that started it is gone.

**Progress is pushed, not asked for.** After writing the row, each step writes a
snapshot to the run's own stream, and `/export/stream` relays it exactly the way
the processing stream does — same SSE shape, same indexed resume, so a client
that drops picks up at the event after the last one it saw. A watcher therefore
costs one read to find out whether there is anything to watch, one connection
while there is, and one read at the end for the archive link, which is minted
per read and short-lived. It used to be a query every 1.5 seconds per watcher,
for a run that spends most of its time inside a single document with nothing new
to say.

Events are whole snapshots rather than deltas: a batch is a couple of dozen
entries at most, and the saving from sending differences is nothing next to a
client that missed one and is now quietly wrong. The stream carries filenames,
states and counts — never a category, a pattern or anything else from inside a
document. If the stream cannot be held open at all, the client falls back to
reading the row every five seconds rather than showing a count that has stopped
moving.

**Stopping** sets `cancelRequested` and then cancels the run. The flag is what
a step between documents reads, so the document being redacted right now
finishes and is kept — it has already been paid for in export allowance — and
the run is cancelled so a hung step cannot keep spending that allowance on
documents nobody wants. Whatever was exported before the stop is still
downloadable: those artifacts were verified before the reviewer changed their
mind.

The archive itself is not built here. `GET /api/batches/:id/download` assembles
it from the artifacts this run produced, re-hashing each against the checksum it
passed verification with — that is a download, and it streams to the client that
asked for it.

---

## 6. Expiry

The sweep (`lib/workflows/sweep.ts`) runs on a schedule, and three things can
run it (#183):

- **the built-in scheduler** in every process that runs workers
  (`lib/runtime/scheduler.ts`): every `ANONIFY_SCHEDULER_INTERVAL_SECONDS`
  (300), ±10%, the first tick one interval after start. A tick still running
  when the next is due is skipped, and the scheduler stops, waiting for its
  sweep, when the process drains (§8). `ANONIFY_SCHEDULER=off` turns it off;
- **`/api/cron/cleanup`**, for Vercel's cron (`vercel.json`) and platform
  schedulers that call a URL;
- **`pnpm cleanup`** / **`anonify cleanup`**, for job-style schedulers. It is
  bundled without the workflow runtime, so it purges and does not restart or
  admit runs.

Each sweep:

0. Takes the sweep lock, `anonify.sweep`. Whichever trigger comes second
   steps aside, so exactly one replica sweeps per interval, and mixing
   triggers is safe.

1. Mark documents past `expiresAt` as expired, so the workspace stops serving
   them mid-window.
2. For each expired document, delete every artifact it owns — source, the
   upload (and its key) if ingest never got to it, the normalized model, every export
   — then the row.
3. Prune empty batches and stale rate-limit windows.
4. Restart runs a lost worker left behind (§8).
5. Admit documents stuck in the queue: admission's backstop.

Each sweep the scheduler leads logs `{"context":"scheduler","leader":true,"durationMs":…}`.

A single run is **bounded by time, not by a count** (#170). It reads expired
documents 50 at a time and keeps going until there are none, or until
`ANONIFY_CLEANUP_BUDGET_MS` (default 240000, inside the cron route's 300
seconds) is spent, and reports `remaining: true` when it stopped with some
left. `pnpm cleanup` has no function limit, so it runs without a budget. It
used to stop at 50 documents a run, which on a once-a-day cron meant at most 50
a day were ever deleted.

Within a page, `ANONIFY_CLEANUP_CONCURRENCY` (default 8) documents are purged at
once, and each document's objects are deleted in one request where the backend
allows it (`DeleteObjects` on S3, `del` with a list on Vercel Blob). A message
and its attachments on the same page are purged by the message alone, so no two
workers touch the same rows.

**One sweep at a time.** Every worker's timer, a platform cron, `pnpm cleanup`
and a slow run overlapping the next tick can all start a sweep. Each takes
`pg_try_advisory_xact_lock(hashtext('anonify.sweep'))` in a transaction held
open for the run (`lib/database/locks.ts`). One that does not get it returns
`{ skipped: "another sweep is running" }` with a 200 and does nothing. The lock
is the transaction's, so it is released however the sweep ends, and it holds
through a transaction pooler. With `DATABASE_POOL_MAX=1` the sweep runs without
it, since the lock would hold the only connection the sweep has.

**Order matters.** The row is the only thing that knows where the bytes are, so
it is deleted last and only if storage cleared. A document whose storage failed
keeps its record and is retried next run. A blob that is already gone counts as
deleted, which is what makes the job idempotent.

A message and the attachments it was expanded into share an expiry, so a page
of this sweep routinely holds both. Purging the message takes its attachments
with it — their rows cascade from its — so the ones already gone are skipped
rather than purged into a row that is no longer there.

**Pruning side-effects.** After the document sweep, three more tables are
tidied on the same run, both swallowing errors to `0` so a prune failure cannot
abort the expiry pass that does the load-bearing work:

- `pruneEmptyBatches` — a batch holds the decisions taken across its documents
  (patterns a person typed, which is document content in the plainest sense).
  Once its documents are gone nothing points at them, so the batch row goes on
  the same sweep. The count pruned is returned in `CleanupResult.batchesPruned`.
- `pruneOwnerRules` — global rules outlive every document, so the purge above
  never reaches them. One that has gone unused for 30 days (the life of the
  session cookie that owns it) is deleted. The count pruned is returned in
  `CleanupResult.ownerRulesPruned`.
- `pruneRateLimits` — drops rate-limit windows that have aged out. The count
  pruned is returned in `CleanupResult.rateLimitsPruned`.

Both this sweep and the explicit "delete now" go through the same
`purgeDocument`, so there is one list of what a document owns. An earlier version
of the delete route removed only the source and the export and left the
normalized model — which contains the document's text — behind in storage with
nothing tracking it.

Retention windows are capped at 72 hours from **creation**, and extending
recomputes from creation rather than from now. Renewing repeatedly converges on
the ceiling instead of walking it forward
(`lib/documents/retention.ts`, and a test that renews five times across three
days to prove it).

---

## 7. Failure, from the user's side

Every failure mode ends somewhere honest:

| Failure | What the user sees | What is true |
| --- | --- | --- |
| Model provider down | Suggestions are sparse or absent | Deterministic detection still ran; manual redaction works |
| Extractor throws | "We couldn't analyze this document" + Retry | Source is untouched |
| Quota exceeded | The limit, and when it resets | Nothing was deleted |
| Stream drops | Reconnects and resumes | Run continues regardless |
| Export verification fails | "did not pass verification and was not saved" | No file was written, no link issued |

The recurring sentence in the error copy — *your original file is safe and was
not modified* — is not reassurance. It is the architecture: the source is never
mutated, so it is simply true.

The full list of failure codes, their meanings, retryability, and how a thrown
error is classified into one is in [failure-codes.md](./failure-codes.md).

## 8. Shutdown and lost workers

`lib/runtime/shutdown.ts`, `lib/workflows/recovery.ts`

Scaling *down* is where work gets lost (#182). Every rolling deploy,
scale-in, spot reclaim and node drain sends `SIGTERM`, waits a grace period,
then sends `SIGKILL`.

### A graceful stop

The image sets `NEXT_MANUAL_SIG_HANDLE=true`, so the app owns `SIGTERM` and
`SIGINT` instead of Next.js, and `tini` forwards them. On the first one:

1. **Readiness drops.** `/api/ready` answers 503, so load balancers stop
   sending traffic. `/api/health` stays 200: nothing is broken.
2. **A pause** of `ANONIFY_DRAIN_READY_DELAY_MS` (5000), so they notice
   before anything stops answering. This is what avoids 502s in a rollout.
3. **Workers stop taking work.** The job runner stops claiming jobs and
   waits for the ones it holds (`world.close()`, graphile-worker's graceful
   stop). Each of those steps reaches this server over HTTP through the
   loopback relay, and the server is still listening, so they finish.
4. **HTTP closes.** Progress streams end with a comment frame and no `end`
   event, so their clients reconnect and resume from their last index on
   another replica. The servers stop accepting connections and answer the
   requests already in flight.
5. **Connections are released**, and the process exits 0.

The whole sequence has `ANONIFY_DRAIN_SECONDS` (120) from the signal. Past
it, the process logs what was still running, step names, attempts and how
long they had run and never content, and exits 1. A second signal exits at
once.

The job runner (graphile-worker) installs its own signal handlers, and the
world gives no way to turn them off. They would race this sequence, and they
re-raise the signal when they are done. So they are taken off once the runner
has started, and stopping it is left to step 3.

Without `NEXT_MANUAL_SIG_HANDLE=true` in the *process* environment (Next reads
it before `.env`), Next closes its server at once, as before, and a worker
logs a warning at start.

### Grace periods per platform

Give the drain `ANONIFY_DRAIN_SECONDS` = the platform's grace period minus
ten seconds.

| Platform | Setting | Default | Suggested |
| --- | --- | --- | --- |
| Docker Compose | `stop_grace_period` | 10s; Anonify's file sets 130s | 130s |
| Kubernetes | `terminationGracePeriodSeconds` | 30 | 130 |
| AWS ECS | `stopTimeout` | 30 | 120 (Fargate's maximum), with `ANONIFY_DRAIN_SECONDS=110` |
| Azure Container Apps | `terminationGracePeriodSeconds` | 30 | 130 |
| Google Cloud Run | none | 10s on scale-in | `ANONIFY_DRAIN_SECONDS=8`, `ANONIFY_DRAIN_READY_DELAY_MS=0` |

Cloud Run's ten seconds is shorter than many steps. That is survivable
because every step can be run again, and the next section is what runs it.

### Lost workers

A worker killed hard (out of memory, `SIGKILL` after its grace period, a node
gone) keeps the lock on its job until graphile-worker decides the job is
abandoned, about four hours later. graphile-worker 0.16.6 has no setting for
that, and the world would not pass one through. The document would sit at
"extracting" all that time.

The sweep (`/api/cron/cleanup`) looks for documents a run is working on whose
last sign of progress, the row changing or a processing event, is older than
`ANONIFY_STUCK_RUN_MINUTES` (20). For each one it:

1. cancels the run, so it cannot write over what happens next. A run that
   will not cancel is left for the next sweep;
2. clears `workflowRunId` and sets `queued`, counting the restart in
   `metadata.recoveries`;
3. lets admission, which runs next in the same sweep, start a fresh run.

That is safe because every step can run again: ingest returns early once the
source is stored, and usage is charged once, by a flag on the row (§3). After
two restarts the third loss fails the document with `worker-lost`, which can
be retried. Something about that document, or that deployment, is killing
the process that reads it, and a loop would hide it.

From here a run that is only waiting its turn in a backed-up queue looks the
same as one whose worker died. Keep `ANONIFY_STUCK_RUN_MINUTES` above the
longest healthy step and the longest a job waits for a worker.
