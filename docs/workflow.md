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

### `extractAndNormalize` — one vocabulary from four formats

Reads the sealed source back, **re-verifies the checksum** (storage that returns
different bytes than it was given is a problem worth catching before those bytes
are parsed), and dispatches to the format pipeline — see
[pipelines.md](./pipelines.md).

The normalized model is then sealed under the same document key and stored
outside the database. It contains the document's text, and text in a database
column is text in every backup and every query log.

This is also where the demo allowance is charged, because it is the first moment
the real cost is known: pages for a document, cells for a workbook. Going over
stops the pipeline — it never deletes what the user uploaded.

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

---

## 5. Expiry

A second workflow (`lib/workflows/cleanup.ts`) runs every 15 minutes. On Vercel
that schedule comes from `vercel.json`; nothing outside Vercel reads that file,
so a self-hosted install drives it with `pnpm cleanup` from cron or with the
opt-in `scheduler` service in `docker-compose.yml`. Either way:

1. Mark documents past `expiresAt` as expired, so the workspace stops serving
   them mid-window.
2. For each expired document, delete every artifact it owns — source, the
   plaintext upload if ingest never got to it, the normalized model, every export
   — then the row.
3. Prune stale rate-limit windows.

**Order matters.** The row is the only thing that knows where the bytes are, so
it is deleted last and only if storage cleared. A document whose storage failed
keeps its record and is retried next run. A blob that is already gone counts as
deleted, which is what makes the job idempotent.

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

## 6. Failure, from the user's side

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
