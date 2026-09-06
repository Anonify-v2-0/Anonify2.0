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

### `ingestUpload` — take ownership of the bytes

The browser uploaded straight to Blob storage, so this is the first moment the
server sees the file.

1. Fetch the plaintext upload.
2. Reject empty or oversized files.
3. **Sniff the content.** The declared MIME type and the filename are hints; the
   magic bytes decide. A `.pdf` that is actually a zip is rejected rather than
   guessed at.
4. SHA-256 the bytes.
5. Seal under a fresh per-document data key; store as `source.bin`.
6. Delete the plaintext upload.

The step is idempotent: on replay it sees `sourceBlobKey` already set and returns
early rather than re-encrypting under a second key and orphaning the first.

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

For images it additionally runs a vision pass over the actual pixels.

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

```
document.queued → document.extracting → document.normalizing
  → document.ai.started → document.ai.progress ×N
  → document.redaction.created → document.ready | document.failed
```

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

A second workflow (`lib/workflows/cleanup.ts`) runs every 15 minutes. On Vercel
that schedule comes from `vercel.json`; nothing outside Vercel reads that file,
so a self-hosted install drives it with `pnpm cleanup` from cron or with the
opt-in `scheduler` service in `docker-compose.yml`. Either way:

1. Mark documents past `expiresAt` as expired, so the workspace stops serving
   them mid-window.
2. For each expired document, delete every artifact it owns — source, the
   plaintext upload if ingest never got to it, the normalized model, every export
   — then the row.
3. Prune empty batches and stale rate-limit windows.

A single run is **bounded to `BATCH_SIZE = 50` documents** (`take: BATCH_SIZE`
on the expiry query), so the sweep cannot exceed its function's time budget. A
backlog is worked down over successive runs rather than in one.

**Order matters.** The row is the only thing that knows where the bytes are, so
it is deleted last and only if storage cleared. A document whose storage failed
keeps its record and is retried next run. A blob that is already gone counts as
deleted, which is what makes the job idempotent.

A message and the attachments it was expanded into share an expiry, so a page
of this sweep routinely holds both. Purging the message takes its attachments
with it — their rows cascade from its — so the ones already gone are skipped
rather than purged into a row that is no longer there.

**Pruning side-effects.** After the document sweep, two more tables are
tidied on the same run, both swallowing errors to `0` so a prune failure cannot
abort the expiry pass that does the load-bearing work:

- `pruneEmptyBatches` — a batch holds the decisions taken across its documents
  (patterns a person typed, which is document content in the plainest sense).
  Once its documents are gone nothing points at them, so the batch row goes on
  the same sweep. The count pruned is returned in `CleanupResult.batchesPruned`.
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
