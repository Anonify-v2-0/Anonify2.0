# HTTP API reference

Every route under `app/api/`. This is the canonical reference; the request paths
sketched in [architecture.md](./architecture.md) §2 and the batch-export
endpoints in [workflow.md](./workflow.md) §5 are the same routes, expanded
here.

All routes run on the Node.js runtime and return JSON unless the response is a
binary stream. Bodies are validated with Zod; a body that fails parsing is a
`400`, and a body that is absent or unreadable is treated as empty rather than
as a crash.

---

## Auth model

There is no account. Three kinds of authorization appear, each answering a
different question:

| Kind | How it is established | What it authorizes |
| --- | --- | --- |
| **Session** | httpOnly cookie carrying a server-issued random id; identity derived in `lib/security/fingerprint.ts` | Ownership of the caller's own documents and batches |
| **Signed token** | HMAC-signed short-lived token from `lib/security/signed-url.ts`, passed as `?token=` | A single download (document artifact or batch archive) |
| **CRON_SECRET** | `Authorization: Bearer $CRON_SECRET` header | The cleanup sweep |

A signed token is *necessary but not sufficient* for downloads: the route still
re-derives the caller's session and re-checks ownership, and re-hashes the
bytes against the checksum recorded at export time. A token for someone else's
document is refused; a token whose bytes no longer match is refused.

### Ownership is not probeable

`requireDocument` (in `lib/security/access-control.ts`) is the gate every
document read passes through. A document that exists but belongs to someone
else is reported as **404**, not 403 — so an attacker cannot tell "does not
exist" from "not yours". A document past `expiresAt` is **410**. No session at
all is **401**.

### Response shapes

Successful responses are the JSON the route documents below. Errors share one
shape:

```json
{ "error": "message", ...extra }
```

A rate-limit refusal adds `retryAfterSeconds`, `resetAt`, and `rateLimited:
true`, with a `Retry-After` header. Verification or storage failures surface as
`500` with a generic message; the detail goes to the operator log only.

---

## Conventions shared by every endpoint

| Status | Meaning |
| --- | --- |
| `200` | Success (default). |
| `201` | A resource was created. |
| `202` | A durable run was started; the work is not done yet. |
| `400` | The request body or params failed validation. |
| `401` | No session, or a missing/invalid/expired download token. |
| `403` | A signed token was valid but does not belong to the caller. |
| `404` | No such resource, **or** a resource that exists but belongs to someone else. |
| `409` | The action conflicts with the resource's current state (expired-adjacent, not ready, already running, not in a batch, etc.). |
| `410` | The document has expired. |
| `413` | The uploaded file exceeds `MAX_UPLOAD_BYTES` (local upload only). |
| `429` | Rate limit or quota refused; carries `retryAfterSeconds`. |
| `500` | Verification failure, storage failure, or an unexpected server error. |
| `503` | A required environment variable or the database is unavailable. |

---

## Documents

### `GET /api/documents`

The caller's own documents, newest first. No session means no documents —
returned as `{ documents: [] }` rather than an error, and without any database
or rate-limit work.

- **Auth:** session (optional; absent ⇒ empty list)
- **Params:** none
- **Response `200`:** `{ documents: DocumentSummary[] }`

### `POST /api/documents`

Reserves a document before the browser uploads to Blob storage. This is where
quota, the rate limit and ownership are decided, and where the upload path the
token route will later sign is fixed.

- **Auth:** session (required; minted if absent)
- **Rate limit:** `upload`
- **Body:**
  ```json
  {
    "filename": "report.pdf",
    "size": 1234567,
    "contentType": "application/pdf",
    "preset": "pii",
    "ttlSeconds": 3600
  }
  ```
  `filename` (1–200), `size` (positive, ≤ `MAX_UPLOAD_BYTES`), `contentType`
  (optional, ≤ 200), `preset` (optional, must be a known preset id), `ttlSeconds`
  (must be in `ALLOWED_TTL_SECONDS`, defaults to `DEFAULT_TTL_SECONDS`).
- **Response `201`:**
  ```json
  {
    "id": "doc_...",
    "pathname": "uploads/doc_.../report.pdf",
    "expiresAt": "2026-09-05T12:00:00.000Z",
    "quota": { ... },
    "uploadMode": "vercel-blob" | "local" | "s3"
  }
  ```
- **Errors:** `400` invalid body / unknown preset; `429` upload allowance
  reached; `409`/`503` from `reserveDocument` or config.

### `GET /api/documents/:id`

One document's summary.

- **Auth:** session
- **Rate limit:** `read`
- **Path params:** `id` — document id
- **Response `200`:** `DocumentSummary` — `{ id, originalName, kind, mimeType,
  size, status, pageCount, createdAt, expiresAt, error }`
- **Errors:** `404` not found / foreign; `410` expired.

### `PATCH /api/documents/:id`

Extends a document's retention window. The new expiry is computed from
`createdAt`, never from now, so renewing converges on the demo ceiling rather
than walking forward. Attachments expanded from a message share the parent's
clock and are extended with it.

- **Auth:** session
- **Rate limit:** `processing`
- **Body:** `{ "ttlSeconds": 7200 }` (positive integer)
- **Response `200`:**
  ```json
  {
    "expiresAt": "2026-09-05T14:00:00.000Z",
    "ttlSeconds": 7200,
    "capped": true,
    "ceiling": "2026-09-08T00:00:00.000Z"
  }
  ```
- **Errors:** `400` invalid window; `404`/`410` access; `409` the window would
  exceed the ceiling (carries `ceiling`).

### `DELETE /api/documents/:id`

Deletes a document and every artifact it owns — source, plaintext upload if
ingest never reached it, normalized model, every export — then the row. Goes
through `purgeDocument`, the same list the cleanup sweep uses. The row is
deleted last and only if storage cleared.

- **Auth:** session
- **Path params:** `id`
- **Response `200`:** `{ "deleted": true }`
- **Errors:** `404`/`410` access; `500` some artifacts could not be deleted
  (the row is kept in that case).

### `GET /api/documents/:id/content`

The normalized model the canvas and inspector render from.

- **Auth:** session
- **Rate limit:** `read`
- **Path params:** `id`
- **Response `200`:** the normalized document model (pages, spans, runs, sheets,
  regions — see [architecture.md](./architecture.md) §1 layer B).
- **Errors:** `404`/`410` access; `409` not normalized yet (no
  `normalizedBlobKey` or no encryption key).

### `GET /api/documents/:id/source`

Streams the decrypted source bytes at full fidelity. Authorization happens
here per request — the underlying blob URL is never handed out, nothing is
cached, and the response carries `cache-control: no-store, private` and
`x-content-type-options: nosniff`.

- **Auth:** session
- **Rate limit:** `read`
- **Path params:** `id`
- **Response `200`:** the raw bytes with `content-type` from the document's
  `mimeType`, `content-disposition: inline`.
- **Errors:** `404`/`410` access; `409` still being ingested (no `sourceBlobKey`
  or no encryption key).

### `GET /api/documents/:id/download`

Serves a generated export. Requires a signed token **and** re-checked session
ownership; the bytes are re-hashed and compared against the checksum recorded
at export time, so what is downloaded is provably the artifact that was
verified.

- **Auth:** signed download token (`?token=`) **plus** session ownership
- **Path params:** `id`
- **Query params:**
  - `token` — signed download token (required)
  - `part` — `report` serves the export report for the same artifact, through
    the same token and the same integrity check. It is a second file, not a
    second kind of authorization. Omit (or any other value) for the redacted
    document itself.
- **Response `200`:** the bytes. `content-type` is the artifact's MIME type
  (or `application/json` for the report); `content-disposition: attachment`
  with a filename derived from the original name (`<base>-redacted.<ext>` or
  `<base>-redaction-report.json`).
- **Errors:** `401` missing / invalid / expired token; `403` token is not
  yours; `404` artifact not found, **or** `part=report` requested but the
  artifact has no report; `500` the stored export failed its integrity check.

### `POST /api/documents/:id/retry`

Runs the pipeline again on a document that failed. Ingest is idempotent and
every later step recomputes from the sealed source, so a retry is safe.
Suggestions from the failed attempt are discarded; anything a person touched
(accepted/rejected) is kept.

- **Auth:** session
- **Rate limit:** `processing`
- **Path params:** `id`
- **Body:** none
- **Response `202`:** `{ "runId": "run_..." }`
- **Errors:** `404` not found / foreign, or the row vanished; `409` not in a
  failed state, **or** the upload is no longer available, **or** the failure is
  not retryable (carries `errorCode` and `retryable: false`).

### `GET /api/documents/:id/usage`

What analysis cost for one document: tokens, duration, calls, by task.

- **Auth:** session
- **Path params:** `id`
- **Response `200`:** a per-document usage report (see `lib/ai/usage-report.ts`).
- **Errors:** `404`/`410` access.

### `GET /api/documents/:id/redactions`

Lists the document's redactions, suggestions and accepted alike, ordered by
page then start offset.

- **Auth:** session
- **Rate limit:** `read`
- **Path params:** `id`
- **Response `200`:** `{ "redactions": Redaction[] }`
- **Errors:** `404`/`410` access.

### `POST /api/documents/:id/redactions`

Creates a manual redaction — a text selection, a drawn region, a cell.

- **Auth:** session
- **Path params:** `id`
- **Body:**
  ```json
  {
    "type": "text" | "region" | "cell" | ...,
    "source": "user",
    "category": "person",
    "status": "accepted",
    "page": 1,
    "text": "John Smith",
    "start": 0,
    "end": 9,
    "boundingBox": { "x": 0, "y": 0, "width": 10, "height": 4 },
    "worksheet": "Sheet1",
    "row": 1,
    "column": 2,
    "reason": "named individual"
  }
  ```
  `type` must be in `REDACTION_TYPES`; `source` defaults to `user`; `status`
  defaults to `accepted`. Optional fields depend on `type`.
- **Response `201`:** `{ "redaction": Redaction }`
- **Errors:** `400` invalid redaction; `404`/`410` access.

### `PATCH /api/documents/:id/redactions`

Bulk accept or reject, and choose what accepting does. Accepting is the only
thing that makes a suggestion count at export time, so it is an explicit,
auditable write.

- **Auth:** session
- **Path params:** `id`
- **Body:** `{ "ids": ["red_..."], "status"?: "accepted" | "rejected" | ...,
  "method"?: "mask" | "pseudonymize" | "tokenize" | "encrypt" }`
  (`ids` is 1–2000 non-empty strings; at least one of `status` and `method`
  must be present).
- **Response `200`:** `{ "updated": 3 }` (count of rows actually changed)
- **Errors:** `400` nothing to change, or an unrecognised status or method;
  `404`/`410` access.

`method` is stored, not enforced here. Whether a method is *allowed* is decided
by `lib/redaction/methods.ts` and asked again at export time against the
redaction as it stands then — so a method that stops being defensible (the
category was corrected, the region turned out to have no text) resolves to a
mask rather than being honoured because it was legal when it was saved. See
[the pipelines doc](./pipelines.md#what-happens-to-a-value).

### `DELETE /api/documents/:id/redactions`

Deletes a redaction outright — for one the user created by mistake.

- **Auth:** session
- **Path params:** `id`
- **Query params:** `redactionId` (required)
- **Response `200`:** `{ "deleted": 1 }`
- **Errors:** `400` no redaction specified; `404`/`410` access.

### `POST /api/documents/:id/rules`

A global redaction rule: "redact every occurrence of John Smith". Searched
against the normalized document server-side — no second model trip, no chance
of a different answer for the same string. Every occurrence found is written
as an **accepted** redaction.

With `scope: "batch"` the decision is recorded on the batch and applied to
every document in it. `scope: "batch"` is refused (not silently downgraded) for
a document that is not in a batch.

- **Auth:** session
- **Rate limit:** `processing`
- **Path params:** `id`
- **Body:**
  ```json
  { "pattern": "John Smith", "category": "person", "scope": "document" | "batch" }
  ```
  `pattern` (2–200), `category` (1–60), `scope` defaults to `document`.
- **Response `201`:**
  - document scope: `{ "rule": { id, pattern, category, enabled }, "scope",
    "redactions": [...] }`
  - batch scope: the same plus a `batch` object `{ id, documents, redactions }`
    totalling the rule's reach across the batch.
- **Errors:** `400` invalid rule; `404`/`410` access; `409` document not ready
  (no normalized model), **or** `scope: "batch"` on a document not in a batch.

### `DELETE /api/documents/:id/rules`

Removes a rule and every redaction it created on this document.

- **Auth:** session
- **Path params:** `id`
- **Query params:** `ruleId` (required)
- **Response `200`:** `{ "deleted": <count of redactions removed> }`
- **Errors:** `400` no rule specified; `404`/`410` access.

### `POST /api/documents/:id/process`

Hands a finished client upload to the durable pipeline. Starting the run is
all this does — the work happens in the workflow, so a slow document does not
hold a request open, and a retry of this call resumes the existing run rather
than starting a second one.

- **Auth:** session
- **Rate limit:** `processing`
- **Path params:** `id`
- **Body:** `{ "blobUrl": "https://..." | "local:..." | "s3:..." }` — an
  absolute URL (Vercel Blob) or a `driver:path` key (S3, local). If a run
  already exists for this document the body is ignored and the existing run is
  returned.
- **Response `202`:** `{ "runId": "run_...", "resumed": false }` — or
  `{ "runId", "resumed": true }` (200) when a run was already in flight.
- **Errors:** `400` invalid process request / unrecognised storage handle;
  `429` processing rate limit; `404`/`410` access.

### `GET /api/documents/:id/stream`

Server-sent events carrying the workflow run's progress. The run's stream is
durable and indexed, so a dropped client reconnects with the index of the last
event it saw and picks up exactly there. `supportsCancellation` is set so a
client that navigates away tears the invocation down. Events carry ids,
stages, counts and durations — never document text.

- **Auth:** session
- **Path params:** `id`
- **Query params:** `startIndex` — index of the next event to receive
  (defaults to 0). On reconnect, `lastIndex + 1`.
- **Response `200`:** `text/event-stream`. Each frame is `id: <n>\ndata:
  <json>\n\n`; the stream ends with `event: end`. `maxDuration` 900s.
- **Errors:** `404`/`410` access; `409` no processing run for this document.

### `POST /api/documents/:id/export`

Generates the redacted document: deterministic from accepted redactions,
verified against the artifact it just produced, checksummed, stored encrypted,
and handed back as a signed short-lived link rather than a storage URL. A
verification failure is a refusal to deliver — never a warning on a leaking
file. Shares one definition of "export" (and one verification gate) with the
batch exporter via `lib/redaction/deliver.ts`.

- **Auth:** session
- **Rate limit:** `export`, charged **once per variant**. Each variant is a full
  pass over the document, so a four-variant request spends four of the day's
  exports. If the allowance does not stretch to all of them the whole request
  is refused rather than truncated — a reviewer who asked for a tokenized copy
  and silently got only the masked one has been told something untrue.
- **Path params:** `id`
- **Body** (all optional, defaults shown):
  ```json
  {
    "addLabels": false,
    "sanitizeMetadata": true,
    "imageStyle": "solid",
    "methods": { "person": "tokenize" },
    "variants": [
      { "sanitizeMetadata": true },
      { "sanitizeMetadata": true, "methods": { "person": "tokenize" } }
    ]
  }
  ```
  `imageStyle` is `solid` | `blur` | `pixelate`. `methods` asks for a method by
  category, overriding what each redaction carries; keys are
  `REDACTION_CATEGORIES` and values `REDACTION_METHODS`. An override for a
  mask-only category parses fine and then resolves to a mask — the schema
  checks that the strings are ours, the policy decides whether the answer is
  defensible.

  `variants` asks for more than one output from one review, up to four. Each is
  a full pass with its own artifact, verification and report. Omit it and the
  body is read as a single variant, which is what an older client sends.
- **Response `200`:** the first variant's fields, plus every variant under
  `artifacts`:
  ```json
  {
    "artifactId": "art_...",
    "variant": "redacted",
    "checksum": "sha256...",
    "size": 98765,
    "appliedRedactions": 12,
    "metadataSanitized": true,
    "verifiedValues": 12,
    "downloadUrl": "/api/documents/<id>/download?token=<token>",
    "reportUrl": "/api/documents/<id>/download?token=<token>&part=report",
    "report": { ... },
    "vault": null,
    "artifacts": [ { "...": "one entry per variant" } ]
  }
  ```
  Each artifact's `downloadUrl` and `reportUrl` carry its own short-lived signed
  token.

  `vault` is non-null when that variant tokenized or encrypted something. It is
  returned **inline and stored nowhere** — not in the database, not in blob
  storage — because it holds the original values and the key that recovers
  them. There is no URL for it and no way to ask for it again: the client saves
  it or it is gone. That is also why Anonify cannot reverse an `encrypt` export.
- **Errors:** `409` document is not ready; `500` the generated document did
  not pass verification (not saved), **or** the export report did not pass
  verification (not saved); `429` export rate limit.

### `POST /api/restore`

Puts the values back: upload a tokenized or encrypted export together with the
vault that came with it, and get the original document in the response body.

Takes no document id and stores nothing — not the upload, not the vault, not
the result. The reviewer holds both halves, and a version that worked from
stored state would be a version where Anonify could reverse the redaction
without them.

- **Auth:** session
- **Rate limit:** `export`
- **Body:** `multipart/form-data` with `file` (the redacted document) and
  `vault` (the JSON downloaded with it).
- **Response `200`:** the restored bytes, as `Content-Type` of the detected
  format with `Content-Disposition: attachment`. Three headers carry the
  outcome: `X-Restored-Values`, `X-Unresolved-Values`, and `X-Vault-Matches`
  (whether the vault names this exact artifact — reported rather than
  enforced, because a restore run with the wrong vault produces plausible
  nonsense rather than an error).
- **Errors:** `400` no file, no vault, or a vault that does not parse; `413`
  either file too large; `415` unrecognised file type; `422` the format cannot
  be restored (a PDF or an image was rasterised, so its surrogates are pixels),
  nothing in the document matches the vault, or the vault has no key for the
  ciphertexts in it; `429` export rate limit.

A pseudonymized value never comes back. There is no mapping, anywhere, which is
the whole difference between `pseudonymize` and `tokenize`.

---

## Batches

### `POST /api/batches`

Reserves several documents as one batch. Every file is charged exactly what
it would be charged on its own — one upload token, one upload against the
daily quota; a batch is not a discount. When the allowance runs out partway,
each file gets its own verdict: the accepted ones proceed, the refused ones
are named with a retry time. A batch nothing got into is deleted and the
refusal is returned as `429`.

- **Auth:** session (required; minted if absent)
- **Body:**
  ```json
  {
    "files": [
      { "filename": "a.pdf", "size": 1234, "contentType": "application/pdf" }
    ],
    "preset": "pii",
    "ttlSeconds": 3600
  }
  ```
  `files` is 1–`MAX_BATCH_FILES` entries (`filename` 1–200, `size` positive ≤
  `MAX_UPLOAD_BYTES`, optional `contentType`). `preset` must be a known id.
  `ttlSeconds` must be in `ALLOWED_TTL_SECONDS`.
- **Response `201`:**
  ```json
  {
    "batchId": "batch_...",
    "accepted": [
      { "index": 0, "id": "doc_...", "filename": "a.pdf",
        "pathname": "uploads/...", "expiresAt": "..." }
    ],
    "refused": [
      { "index": 1, "filename": "b.pdf", "reason": "...", "retryAfterSeconds": 60 }
    ],
    "uploadMode": "vercel-blob" | "local" | "s3"
  }
  ```
  `index` is what the browser matches its `File` objects on (names can repeat).
- **Errors:** `400` invalid batch request / unknown preset; `429` no file
  could be started (carries `refused`).

### `GET /api/batches/:id`

One batch: its documents and the decisions being carried across them. The
batch view polls this while anything is still processing.

- **Auth:** session
- **Rate limit:** `read`
- **Path params:** `id`
- **Response `200`:** `{ "batch": BatchOverview }`
- **Errors:** `404` not found / foreign (batches use the same 404-not-403
  rule as documents).

### `GET /api/batches/:id/download`

The batch archive: one export per document, plus its report, plus a roll-up
`batch-report.json`. Nothing is generated here — the archive is assembled from
artifacts the export already produced and verified, and each is re-hashed
against its recorded checksum. An artifact that fails is left out and named
in the batch report rather than failing the whole archive. Assembled in
memory with a 150 MiB ceiling; what does not fit is named as skipped.

A document the reviewer had tokenized or encrypted also gets its vault, as
`<name>-vault.json`. **That means the archive holds both the reversible file
and the thing that reverses it**, which the batch report says in as many words:
separate them before sharing either. A vault whose checksum does not match is
left out rather than shipped — half a mapping restores half a document — while
the file itself still goes in, having been verified on its own.

- **Auth:** signed batch token (`?token=`) **plus** session ownership
- **Path params:** `id`
- **Query params:** `token` — signed batch token (required)
- **Response `200`:** `application/zip`, `content-disposition: attachment;
  filename="anonify-batch-redacted.zip"`, `maxDuration` 300s.
- **Errors:** `401` missing / invalid / expired token; `403` token is not
  yours; `404` batch not found / foreign; `409` nothing exported yet.

### `DELETE /api/batches/:id/rules`

Withdraws a decision from the whole batch. Removes the rule and every
redaction it produced, everywhere it reached. Batch rules are *created*
through `POST /api/documents/:id/rules` with `scope: "batch"` — a decision
comes from looking at something.

- **Auth:** session
- **Rate limit:** `processing`
- **Path params:** `id`
- **Query params:** `ruleId` (required)
- **Response `200`:** the result of `removeBatchRule` (rule removed + counts).
- **Errors:** `400` no rule specified; `404` batch not found / foreign.

### `GET /api/batches/:id/export`

Where the batch export run has got to. The progress lives on the row, so it
survives a closed tab, a reload, and the recycling of the function that
started it. The archive link is minted at read time (not stored) for runs that
are `ready`, or `cancelled` with `exported > 0`.

- **Auth:** session
- **Path params:** `id`
- **Response `200`:** `{ "export": BatchExportView | null }` — includes
  `status`, totals, and `downloadUrl` when deliverable.
- **Errors:** `404` batch not found / foreign.

### `POST /api/batches/:id/export`

Starts a batch export run. A second click while one is already going joins it
rather than starting a rival run. One token starts the run; per-document
export allowance is charged inside it, one document at a time, exactly as a
single export would be.

- **Auth:** session
- **Rate limit:** `processing`
- **Path params:** `id`
- **Body** (all optional, defaults shown):
  ```json
  {
    "addLabels": false,
    "sanitizeMetadata": true,
    "imageStyle": "solid",
    "method": "mask",
    "methodByDocument": { "doc_...": "tokenize" }
  }
  ```
  A batch produces **one artifact per document**, so it takes one method per
  file rather than the `variants` a single export accepts — see
  [the pipelines doc](./pipelines.md#a-batch-gets-a-method-per-file-not-variants-per-file)
  for why. `method` covers every file the reviewer did not single out;
  `methodByDocument` names the ones they did. An id that is not in this batch
  is ignored rather than refused: the run resolves the method per document it
  actually reaches, so a stale id from a document deleted between opening the
  dialog and pressing the button decides nothing.

  A file marked `tokenize` or `encrypt` still gets its government ids, bank and
  card numbers, API keys and faces removed — the category table in
  `lib/redaction/methods.ts` decides that, not the pick.
- **Response `202`:** `{ "export": BatchExportView }` (the newly created row,
  with a `downloadUrl` once deliverable).
- **Errors:** `404` batch not found / foreign; `409` batch has no documents
  left; `429` too many export runs (carries `rateLimited: true`).

### `DELETE /api/batches/:id/export`

Stops a run in progress. Sets `cancelRequested` first (so a step between
documents stops on its own), then cancels the run (so a hung step cannot keep
spending allowance), then writes the final `cancelled` state. The document
being redacted right now finishes and is kept.

- **Auth:** session
- **Path params:** `id`
- **Response `200`:** `{ "export": BatchExportView | null }`
- **Errors:** `404` batch not found / foreign; `409` no export running for
  this batch.

### `GET /api/batches/:id/export/stream`

The batch export's progress, as server-sent events. The run writes a whole
snapshot every time a document settles; this relays them with the same SSE
shape and indexed resume as the processing stream. A run that has already
finished is a `409` rather than an empty stream — holding a connection open
for something that will never speak is worse than saying so.

- **Auth:** session
- **Path params:** `id`
- **Query params:** `startIndex` — index of the next event to receive
  (defaults to 0). On reconnect, `lastIndex + 1`.
- **Response `200`:** `text/event-stream`, `maxDuration` 900s. Each frame is
  `id: <n>\ndata: <json snapshot>\n\n`; ends with `event: end`. Snapshots
  carry filenames, states and counts — never a category or pattern.
- **Errors:** `404` batch not found / foreign; `409` no export to watch, **or**
  that export is no longer running.

---

## Upload

Two upload paths exist, selected by `uploadMode` in the reserve response.
Downstream — ingest, extraction, export — cannot tell the difference.

### `POST /api/upload/token`

Issues short-lived client upload tokens for Vercel Blob. The browser never
gets a general-purpose write token: each is scoped to a single path that
belongs to a document the caller already reserved and still owns, with the
size ceiling and a short expiry baked in. Only reachable when Vercel Blob is
configured.

- **Auth:** session
- **Body:** the `@vercel/blob` `HandleUploadBody`, with a `clientPayload` of
  the reserved document id.
- **Response `200`:** the `@vercel/blob` client upload token result.
- **Errors:** `409` Vercel Blob is not configured (use `/api/upload/local`);
  `404` document not found / foreign (raised inside `handleUpload` and
  surfaced via the generic handler); the document is not in `uploading`
  state.

### `POST /api/upload/local`

Browser uploads for every backend that is not Vercel Blob (S3, local
filesystem). The bytes come through here and are written with the same storage
abstraction everything else reads from. Self-hosted, so the ceiling is the
application's own `MAX_UPLOAD_BYTES` rather than a serverless body limit.

- **Auth:** session
- **Rate limit:** `upload`
- **Body:** `multipart/form-data` with fields `documentId` and `file`.
- **Response `201`:** `{ "url": "<storage key>", "size": 12345 }`
- **Errors:** `400` expected multipart / missing document reference / no
  file / empty file; `404` document not found / foreign; `409` document has
  already been uploaded; `413` file too large; `429` upload rate limit.

---

## System

### `GET /api/limits`

What this caller has left — rate-limit windows and daily quota. Read-only on
purpose, and not itself rate limited: a panel that reports the allowance must
not spend it. No session means nothing has been spent, so the answer is the
configuration with everything full and no database work.

- **Auth:** session (optional; absent ⇒ full limits, empty quotas)
- **Params:** none
- **Response `200`:** `LimitsReport` — `{ profile, rateLimits[], quotas, batch }`.
  Each `rateLimits` entry is `{ name, limit, windowSeconds, remaining,
  resetAt }` (`resetAt` is `null` while `allowed`).

  `batch` is `{ maxFiles, processing, exporting }`: how many documents one
  batch may hold, how many of this caller's may process at once, and how many a
  batch export works on at once. A rate limit says how often work may *start*
  and these say how much may be *in flight* — the second is what actually
  bounds memory and model spend, and only one of them existed until recently.
  Reported here because a browser bundle cannot read a server environment
  variable, and the upload panel needs to know what this deployment takes.

### `GET /api/usage`

Analysis usage across the caller's own documents — tokens, duration, calls,
by model, with an estimated cost. No session means no documents and no spend,
answered without touching the database.

- **Auth:** session (optional; absent ⇒ zeroes)
- **Params:** none
- **Response `200`:** `{ documents, totals, byModel[], estimatedCostUsd }`
  (an `AggregateUsage` report; `estimatedCostUsd` is `null` when unset).

### `GET /api/cron/cleanup`

The scheduled expiry sweep. Vercel signs cron invocations with `CRON_SECRET`;
without that header the endpoint refuses, so nobody can trigger deletion from
outside. The work is idempotent, which is what makes retrying a partial run
safe. Outside Vercel this is driven by `pnpm cleanup` or the `scheduler`
service in `docker-compose.yml` (see [workflow.md](./workflow.md) §6).

- **Auth:** `CRON_SECRET` — `Authorization: Bearer $CRON_SECRET`. If
  `CRON_SECRET` is unset, the endpoint allows the call only outside
  production (so local development does not require it).
- **Params:** none
- **Response `200`:** `{ marked, ...cleanupResult }` — the count of rows
  marked expired and the result of deleting their artifacts.
- **Errors:** `401` unauthorized.

> The route exports `GET`, matching the Vercel Cron convention. The issue
> checklist named it `POST`; the code is the source of truth here.
