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
| `422` | A search or rule pattern ran out of its budget (too many matches, or too long spent matching). Nothing was applied. |
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
- **Response `200`:** `{ documents: DocumentSummary[] }`, with a weak `ETag`
- **Response `304`:** the request's `If-None-Match` names the current `ETag`.
  No body. The tag is a hash of the body, so it changes with anything the list
  shows, including redaction counts. The request still spends from the `read`
  bucket.

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
    "ttlSeconds": 3600,
    "uploadEncryption": "v1"
  }
  ```
  `filename` (1–200), `size` (positive, ≤ `MAX_UPLOAD_BYTES`), `contentType`
  (optional, ≤ 200), `preset` (optional, must be a known preset id), `ttlSeconds`
  (must be in `ALLOWED_TTL_SECONDS`, defaults to `DEFAULT_TTL_SECONDS`),
  `uploadEncryption` (optional: `"v1"` asks for an upload key and promises a
  sealed upload; absent means the upload will be plaintext).
- **Response `201`:**
  ```json
  {
    "id": "doc_...",
    "pathname": "documents/doc_.../upload/report.pdf",
    "expiresAt": "2026-09-05T12:00:00.000Z",
    "quota": { ... },
    "uploadMode": "vercel-blob" | "s3-presigned" | "server-route",
    "uploadEncryption": { "format": "v1", "key": "<base64>", "chunkShift": 20 } | null
  }
  ```
  `uploadEncryption` is present when it was asked for. `key` is the raw
  single-use upload key, and this is the only response that carries it. Seal
  the file in the v1 chunked envelope with that key, `pathname` as the logical
  key, and `2^chunkShift`-byte chunks (`lib/storage/chunked-web.ts` does it),
  and upload the ciphertext. See [storage.md](./storage.md#sealed-uploads).
- **Errors:** `400` invalid body / unknown preset / plaintext upload refused
  (`ANONIFY_UPLOAD_ENCRYPTION=required` and no `uploadEncryption`); `429`
  upload allowance reached; `409`/`503` from `reserveDocument` or config.

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

Deletes a document and every artifact it owns — source, the upload if
ingest never reached it, normalized model, every export — then the row. Goes
through `purgeDocument`, the same list the cleanup sweep uses. The row is
deleted last and only if storage cleared.

- **Auth:** session
- **Path params:** `id`
- **Response `200`:** `{ "deleted": true }`
- **Errors:** `404`/`410` access; `500` some artifacts could not be deleted
  (the row is kept in that case).

### `GET /api/documents/:id/content`

The normalized model the canvas and inspector render from, whole or a page at
a time. For a model written with a page index (`Document.normalizedIndex`), a
page is one ranged read of the storage chunks that cover it; a model written
before the index existed is read whole and the page cut from it. See
[streaming.md](./streaming.md) §3.

- **Auth:** session
- **Rate limit:** `read`
- **Path params:** `id`
- **Query params:**
  - `view=outline` — everything but the pages (kind, metadata, a workbook's
    sheets, an image's regions) plus `pageCount` and `pageNumbers`. What the
    editor opens first.
  - `page=N` — one page (1-based). `400` if `N` is not a positive integer,
    `404` if the document has no such page.
  - neither — the whole model, as before.
- **Response `200`:** the normalized document model (pages, spans, runs, sheets,
  regions — see [architecture.md](./architecture.md) §1 layer B), its outline,
  or one `NormalizedPage`.
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

Streamed: the artifact is decrypted a chunk at a time and hashed as it passes,
and its last piece is held back until the hash matches. A mismatch is logged
and breaks the download off short — never a complete file that failed its
check — rather than answering `500` before the first byte, which needed the
whole artifact in memory first.

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
  artifact has no report. A stored export that fails its integrity check
  ends the stream early instead of completing it.

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

### `POST /api/documents/:id/search`

Searches the whole document on the server, over the normalized model, a page
at a time — the review screen's find. POST rather than GET because the pattern
is usually the very value being looked for, and a query string is what access
logs keep. See `lib/redaction/search.ts`.

- **Auth:** session
- **Rate limit:** `search` without `page` (a whole-document scan, once per
  query as the reviewer types); `read` with `page`
- **Body:**
  ```json
  {
    "spec": { "kind": "literal" | "regex", "pattern": "EMP-\\d{5}",
              "matchCase": false, "wholeWord": false },
    "page": 3
  }
  ```
  `pattern` is 1–500 characters; see [Pattern rules](#pattern-rules). `page`
  is optional.
- **Response `200` without `page`** — where every hit is: `{ total, pages:
  [{ page, count }], cells: [{ worksheet, row, column }], cellsTruncated }`. A
  spreadsheet cell counts once however often it matches, because a cell is
  redacted whole, so `total` is exactly what "Redact all" would write.
- **Response `200` with `page`** — `{ page, hits: [{ start, end }] }`, offsets
  into that page's text.
- **Errors:** `400` invalid body, or a pattern the compiler refuses (the
  message says why; `code` names it); `409` not ready; `422` more than 50,000
  matches or the time budget spent; `429` search rate limit.

### `GET /api/documents/:id/rules`

Every rule that reaches this document, at every scope: its own rules, its
batch's decisions, and the owner's global rules.

- **Auth:** session
- **Rate limit:** `read`
- **Response `200`:** `{ "rules": RuleView[] }` (`types/rules.ts`): `id`,
  `scope`, `kind`, `pattern`, `matchCase`, `wholeWord`, `category`, `enabled`,
  `here` (redactions in this document), `total` and `documents` (its reach),
  `copyId` (the `ruleId` this document's redactions carry), and for a global
  rule `expiresAt`.

### `POST /api/documents/:id/rules/preview`

What a rule would do, before it does it: the count and the first 20 matches in
context. Runs under the compiler and budget the rule itself runs under, so a
preview that succeeds is a rule that will. Writes nothing.

- **Auth:** session
- **Rate limit:** `search`; `processing` for `scope: "batch"`, which scans every
  document in the batch
- **Body:** `{ "spec": PatternSpec, "scope": "document" | "batch" | "global" }`
- **Response `200`:** `{ here: { count, samples: [{ page?, worksheet?, row?,
  column?, before, match, after }] } }`; for `scope: "batch"` also `batch: {
  documents: [{ id, name, status, count | null, note? }], total }`.
- **Errors:** `400` refused pattern; `409` not ready; `422` over budget — in a
  batch preview the message names the document that would fail; `429` rate
  limit.

### `POST /api/documents/:id/rules`

Creates a rule: "redact every occurrence of John Smith", or every match of
`EMP-\d{5}`. Searched against the normalized document server-side — no second
model trip, no chance of a different answer for the same pattern. Every match
is written as an **accepted** redaction carrying the rule's id.

Every document a rule reaches is searched within budget before anything is
written, and the rule and its redactions are then written in one transaction:
a rule is never partly applied. `scope: "batch"` records the decision on the
batch and applies it to every document in it; it is refused (not silently
downgraded) for a document that is not in a batch. `scope: "global"` records it
for the owner — applied here now, and to every document they upload
afterwards (see `OwnerRule` in [data-model.md](./data-model.md)).

- **Auth:** session, renewed (a global rule lasts as long as it does)
- **Rate limit:** `processing`
- **Path params:** `id`
- **Body:**
  ```json
  { "pattern": "EMP-\\d{5}", "kind": "regex", "matchCase": true,
    "wholeWord": true, "category": "customer-id",
    "scope": "document" | "batch" | "global" }
  ```
  The body from before RegEx rules — `{ pattern, category, scope }` — still
  means a case-insensitive literal. A literal is 2–500 characters, a RegEx
  1–500; `category` 1–60.
- **Response `201`:** `{ "rule": { id, pattern, kind, category, enabled },
  "scope", "redactions": [...] }`; for `batch` also `batch: { id, documents,
  redactions }` totalling the rule's reach.
- **Errors:** `400` invalid body or refused pattern; `404`/`410` access; `409`
  not ready, `scope: "batch"` outside a batch, or more than 200 global rules;
  `422` over budget (nothing was written); `429` rate limit.

### `PATCH /api/documents/:id/rules`

Switches a rule off or on, or rewrites it, at whatever scope it lives, and
everywhere it reached. Off removes its redactions and keeps it listed; on, or
an edit, re-plans it and replaces its redactions in one transaction.

- **Auth:** session, renewed
- **Rate limit:** `processing`
- **Body:** `{ "id", "scope", "enabled"?, "spec"?, "category"? }`
- **Response `200`:** `{ "updated": true }`
- **Errors:** `400`; `404` no such rule in scope; `409`; `422`; `429`.

### `DELETE /api/documents/:id/rules`

Removes a rule and every redaction it created, everywhere it reached.

- **Auth:** session
- **Rate limit:** `processing`
- **Path params:** `id`
- **Query params:** `ruleId` (required); `scope` — `document` (default),
  `batch` or `global`. With `document`, `ruleId` must be this document's own
  rule: its copy of a batch or global rule (`copyId`) is `404`, and is removed
  at the rule's own scope.
- **Response `200`:** `{ "deleted": <redactions removed> }`, plus `documents`
  for a batch or global rule.
- **Errors:** `400` no rule specified; `404` no such rule in scope; `404`/`410`
  access; `429` rate limit.

### `POST /api/documents/:id/assistant`

One turn of a conversation with Hush, the review assistant, streamed as an AI
SDK UI message stream (`useChat` reads it). The server runs an agent loop with
tools over this document (see [editor.md §16](./editor.md#16-hush-the-review-assistant)):

- **Reads** run once `readConsent` is true. The first read without it becomes
  an approval request.
- **Changes** (`create_rule`, `update_rule`, `redact_occurrences`,
  `set_suggestion_status`) always stop as approval requests. The client
  continues the run by sending the conversation back with the reviewer's
  answer.
- Approvals are HMAC-signed when issued and verified when replayed. A forged or
  altered approval is refused before any tool runs.

The loop is bound by the daily spend cap and by the caller's daily
`assistantTokens` allowance (`ANONIFY_QUOTA_ASSISTANT_TOKENS`). Each model step
is recorded in `AiUsage` (`task: "assistant"`) and its tokens are charged to the
allowance. Both are checked before the run and again before every step after
the first, so a run stops where either runs out. A run is at most 12 steps.

- **Auth:** session, renewed (an approved tool can create or edit a global rule)
- **Rate limit:** `processing`
- **Body:**
  ```json
  {
    "messages": [ /* UIMessage[] — the conversation, at most 80 */ ],
    "readConsent": false,
    "view": {
      "currentPage": 3,
      "selected": { "id", "text", "category", "status", "source", "page", "reason" }
    }
  }
  ```
  At most 1.5 MB, counted as the body arrives: a chunked request with no
  `content-length` is cut off at the limit rather than buffered.
- **Response `200`:** a UI message stream (`text/event-stream`). Tool calls
  appear as typed tool parts (`tool-find_occurrences`, `tool-create_rule`, …)
  and pass through `approval-requested` when they need the reviewer.
  `approval.requestReason` is `read-consent` or `change`.
- **Errors:** `400` invalid body; `409` not ready; `413` conversation too long;
  `429` with `code: "allowance"` when the caller's allowance is spent; `503`
  with `code` `not-configured`, `unsupported` or `budget`. An error inside the
  stream is sent as a fixed sentence, never the provider's message; a run
  stopped between steps by the cap or the allowance ends with that sentence.

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
  returned. The handle must be this document's own upload path; a handle the
  server already recorded when the bytes landed takes precedence over this one.
- **Response `202`:** `{ "runId": "run_...", "resumed": false }` — or
  `{ "runId", "resumed": true }` (200) when a run was already in flight.
- **Errors:** `400` invalid process request / unrecognised storage handle /
  the upload does not belong to this document; `429` processing rate limit;
  `404`/`410` access.

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
    "ttlSeconds": 3600,
    "uploadEncryption": "v1"
  }
  ```
  `files` is 1–`MAX_BATCH_FILES` entries (`filename` 1–200, `size` positive ≤
  `MAX_UPLOAD_BYTES`, optional `contentType`). `preset` must be a known id.
  `ttlSeconds` must be in `ALLOWED_TTL_SECONDS`. `uploadEncryption` is as for
  a single document and applies to every file; each still gets its own key.
- **Response `201`:**
  ```json
  {
    "batchId": "batch_...",
    "accepted": [
      { "index": 0, "id": "doc_...", "filename": "a.pdf",
        "pathname": "documents/doc_.../upload/a.pdf", "expiresAt": "...",
        "uploadEncryption": { "format": "v1", "key": "<base64>", "chunkShift": 20 } }
    ],
    "refused": [
      { "index": 1, "filename": "b.pdf", "reason": "...", "retryAfterSeconds": 60 }
    ],
    "uploadMode": "vercel-blob" | "s3-presigned" | "server-route"
  }
  ```
  `index` is what the browser matches its `File` objects on (names can repeat).
- **Errors:** `400` invalid batch request / unknown preset / plaintext upload
  refused; `429` no file could be started (carries `refused`).

### `GET /api/batches/:id`

One batch: its documents and the decisions being carried across them. The
batch view polls this while anything is still processing.

- **Auth:** session
- **Rate limit:** `read`
- **Path params:** `id`
- **Response `200`:** `{ "batch": BatchOverview }`, with a weak `ETag`
- **Response `304`:** `If-None-Match` names the current `ETag`, as for
  `GET /api/documents`. Ownership is checked first, so a tag never turns a
  `404` into a `304`.
- **Errors:** `404` not found / foreign (batches use the same 404-not-403
  rule as documents).

### `GET /api/batches/:id/download`

The batch, downloaded in the shape the reviewer asked for. Nothing is
redacted here — every file is an artifact the export already produced and
verified, re-hashed against its recorded checksum; one that fails is left out
and named in the batch report rather than failing the whole download.

- `output=original` (the default) — one file per top-level upload, in its own
  format. A mailbox is **rebuilt**: its messages' verified exports in mailbox
  order, `From ` separators written fresh (`MAILER-DAEMON` and the redacted
  message's own date, never copied from the source), `>From ` quoting
  reapplied as mboxrd — and then verified as its own export by splitting it
  with the upload's scanner: the same message count, each message equal byte
  for byte to its export, no accepted value on any separator line outside the
  text that is always the same (`From MAILER-DAEMON `, and the placeholder
  date). A message with no verified export is left out and named in the
  report; a mailbox that fails verification is withheld whole, and the
  report's `containers[].failure` says which check it failed
  (`artifact-mismatch`, `count-mismatch`, `message-mismatch`,
  `separator-leak`) and at which message. A message carrying attachments is its
  own export, which already carries its redacted enclosures. One upload is
  served as that file, bare (`inbox-redacted.mbox`, `application/mbox`);
  several are zipped.
- `output=processed` — every document's own output in folders that mirror
  where it came from, named by message number and MIME part path, never by
  subject or filename: `inbox-redacted/0001/message-redacted.eml`,
  `inbox-redacted/0001/attachments/0.2-redacted.pdf`, with each report under
  `reports/` at the same path.
- `output=both` — both, under `original/` and `processed/`, in one zip.

Every zip carries `batch-report.json`, which says which upload each file went
into (`documents[].container`: the upload's id and the part-path chain, never a
name), and for each rebuilt mailbox how many messages went in and which were
left out and why (`containers[]`). Streamed in two passes: every artifact is
first read through a hash and kept nowhere, and a mailbox is built once through
its verifier, which decides what goes in before a byte is sent; then the files
are sent as they are read, each checked again on the way through, a rebuilt
mailbox against the checksum its verification computed. A 150 MiB ceiling
bounds one request's work, charging each file for every read after the hash —
a message of a rebuilt mailbox twice, once for its verifier and once for its
delivery; what does not fit is named as skipped.

A document the reviewer had tokenized or encrypted also gets its vault,
**beside the file and never inside it** — `<name>-vault.json`, or
`inbox-vaults/0001-vault.json` for a message of a rebuilt mailbox. So a
download carrying a vault is always a zip, even for one upload, and it holds
both the reversible file and the thing that reverses it, which the batch report
says in as many words: separate them before sharing either. A vault whose
checksum does not match is left out rather than shipped — half a mapping
restores half a document — while the file itself still goes in, having been
verified on its own.

- **Auth:** signed batch token (`?token=`) **plus** session ownership
- **Path params:** `id`
- **Query params:** `token` — signed batch token (required); `output` —
  `original` | `processed` | `both` (default `original`); `document` — one
  top-level upload's id, to download only that upload (the workspace uses this
  to offer a mailbox as a mailbox); `part=report` — the batch report for the
  same download as JSON, for a download that is a single file with nowhere to
  put one, and served for a download that would be refused `409` or `422` too,
  since the report is what says why. It runs the same verification as the
  download, a rebuilt mailbox included, so it costs what the download does
  less sending the files.
- **Response `200`:** the upload's own type and name for a single original
  file (e.g. `application/mbox`, `filename="inbox-redacted.mbox"`); otherwise
  `application/zip`, `filename="anonify-batch-redacted.zip"` (or
  `<name>-redacted.zip` when `document` names one upload). `maxDuration` 300s.
- **Errors:** `400` unknown `output`; `401` missing / invalid / expired token;
  `403` token is not yours; `404` batch not found / foreign, or `document` is
  not a top-level upload in this batch; `409` nothing exported yet; `422`
  nothing to deliver because a mailbox was withheld — it failed its own
  verification, or none of its messages' exports could go in — with the
  report's note on it as `error`. Its messages may well be exported; the
  report says which check failed.

### `POST /api/batches/:id/search`

Searches every document in the batch, answering with a count per document —
what the search bar's "this batch" list shows. A document still processing is
listed with `count: null` and a `note`, never as `0`.

- **Auth:** session
- **Rate limit:** `processing`
- **Body:** `{ "spec": PatternSpec }`
- **Response `200`:** `{ "documents": [{ id, name, status, count | null, note? }] }`
- **Errors:** `400` refused pattern; `404` batch not found / foreign; `429`
  rate limit.

### `PATCH /api/batches/:id/rules`

Switches a batch decision off or on, or rewrites it, in every document it
reaches — `PATCH /api/documents/:id/rules` with `scope: "batch"`, for the
batch page.

- **Auth:** session
- **Rate limit:** `processing`
- **Body:** `{ "ruleId", "enabled"?, "spec"?, "category"? }`
- **Response `200`:** `{ documents, redactions }` it now reaches.

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
  `status`, totals, the chosen `output`, and `downloadUrl` (carrying that
  `output`) when deliverable.
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
    "methodByDocument": { "doc_...": "tokenize" },
    "output": "original"
  }
  ```
  `output` is the shape of the download — `original`, `processed` or `both`,
  as described under `GET /api/batches/:id/download`. It is not a property of
  the run: every shape is assembled from the same verified artifacts. It is
  recorded so the `downloadUrl` handed back asks for the shape the reviewer
  chose.
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

## Rules

### Pattern rules

A pattern is `{ kind, pattern, matchCase, wholeWord }`
(`lib/redaction/patterns.ts`), and search, rules and Hush all compile it the
same way. A `regex` is compiled by RE2JS: matching is linear in the text
whatever the pattern, and backreferences and lookaround are refused when it
is compiled. `^` and `$` match at line breaks. "Whole word" is Unicode-aware,
not RE2's ASCII `\b`.

A pattern is at most 500 characters and may not match the empty string. In one
document it may spend at most 5 seconds matching and make at most 10,000
matches. A rule over budget fails whole with `422`. A batch or global rule that
goes over budget while it is carried into a document at the end of processing
fails that document with `rule-too-broad` (see
[failure-codes.md](./failure-codes.md)).

### `GET /api/rules`

The caller's global rules, with their patterns unsealed for their owner.

- **Auth:** session (with none, `{ "rules": [] }`)
- **Rate limit:** `read`
- **Response `200`:** `{ "rules": [{ id, kind, pattern, matchCase, wholeWord,
  category, enabled, createdAt, expiresAt, originDocumentId, documents,
  redactions }] }`

### `GET /api/rules/export`

The caller's global rules as a downloadable JSON file: `{ "format":
"anonify.rules", "version": 1, "rules": [{ kind, pattern, matchCase,
wholeWord, category, enabled }] }`. Patterns and options only — no counts,
document ids or dates, because the file travels to other people and instances.

- **Auth:** session
- **Rate limit:** `export`

### `POST /api/rules/import`

Adds a rule file's rules to the caller's global rules. Each pattern is compiled
here, and one this instance refuses is reported rather than stored. Duplicates
are skipped. Imported rules reach future uploads only.

- **Auth:** session (issued if absent)
- **Rate limit:** `processing`
- **Body:** a rule file, as exported.
- **Response `200`:** `{ imported, duplicates, invalid: [{ index, problem }] }`
- **Errors:** `400` not a rule file; `409` would exceed 200 global rules.

### `GET /api/assistant`

Whether Hush can answer on this instance, and through what: `{ available:
true, model, provider }` or `{ available: false, reason: "not-configured" |
"unsupported" | "budget", provider? }`. `provider` is `{ id, label, kind,
model }`, where `kind` is `cloud`, `local`, `subscription` or `gateway`. The
panel's header badges are drawn from it.
Search, shortcuts and hand-written rules never ask, because none of them needs
a model.

- **Rate limit:** `read`

---

## Upload

Three upload paths exist, selected by `uploadMode` in the reserve response:
`vercel-blob` (a scoped token, straight to Blob), `s3-presigned` (a presigned
PUT, straight to the bucket), and `server-route` (through
`/api/upload/local`). Each path carries whatever the client sends, which is
ciphertext when it asked for an upload key at reservation. Downstream (ingest,
extraction, export) cannot tell the paths apart. Every size ceiling is on the
plaintext, so a sealed upload may be larger than `MAX_UPLOAD_BYTES` by exactly
its header and tags.

### `POST /api/upload/token`

Issues short-lived client upload tokens for Vercel Blob. The browser never
gets a general-purpose write token: each is scoped to a single path that
belongs to a document the caller already reserved and still owns, with the
size ceiling and a short expiry baked in. The stored URL gets a random suffix,
so it cannot be worked out from the document id and filename. Only reachable
when Vercel Blob is configured.

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
- **Body:** `multipart/form-data` with fields `documentId` and `file`. For a
  document reserved with `uploadEncryption`, `file` is the sealed envelope and
  is stored exactly as it arrived.
- **Response `201`:** `{ "url": "<storage key>", "size": 12345 }`. The route
  also records the key on the document, so the expiry sweep finds the upload
  even if `/process` is never called.
- **Errors:** `400` expected multipart / missing document reference / no
  file / empty file / not a sealed file (a size no sealer produces); `404`
  document not found / foreign; `409` document has already been uploaded;
  `413` file too large (its plaintext, for a sealed upload); `429` upload rate
  limit.

### `POST /api/upload/presign`

A presigned PUT straight into the S3 bucket, for an install with
`S3_PRESIGNED_UPLOADS=true`. It is issued only for a document reserved with
`uploadEncryption`, and the signature covers the object's exact length.

- **Auth:** session
- **Rate limit:** `upload`
- **Body:** `{ "documentId": "doc_...", "size": 1234 }`, where `size` is the
  sealed object's length in bytes.
- **Response `200`:**
  ```json
  {
    "url": "https://...",
    "method": "PUT",
    "headers": { "content-type": "application/octet-stream" },
    "handle": "s3:documents/doc_.../upload/report.pdf",
    "expiresAt": "..."
  }
  ```
  PUT the sealed bytes to `url` with `headers`, then pass `handle` to
  `/process`.
- **Errors:** `400` invalid body / the document was reserved for a plaintext
  upload / not a sealed size / empty; `404` document not found / foreign;
  `409` already uploaded, or this deployment does not presign uploads; `413`
  plaintext over `MAX_UPLOAD_BYTES`; `429` upload rate limit.

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
- **Response `200`:** `{ marked, ...cleanupResult, admitted }` — the count of
  rows marked expired, the result of deleting their artifacts, and the queued
  documents admitted. The sweep works through the whole backlog within
  `ANONIFY_CLEANUP_BUDGET_MS`; `remaining: true` means it stopped with expired
  documents left for the next run. When another sweep holds the lock it does
  nothing and returns `skipped: "another sweep is running"`, still with a 200.
- **Errors:** `401` unauthorized.

> The route exports `GET`, matching the Vercel Cron convention. The issue
> checklist named it `POST`; the code is the source of truth here.

### `GET /api/health`

Liveness for orchestrators: whether the process answers. No database, storage
or network I/O, so an outage elsewhere does not restart the replica. See
[architecture.md](./architecture.md) §9.

- **Auth:** none
- **Params:** none
- **Response `200`:** `{ status: "ok" }`, `Cache-Control: no-store`.

### `GET /api/ready`

Readiness for orchestrators: whether this replica can take traffic and jobs
now. Checks the database, the storage backend and, where the replica runs the
workflow worker, that the worker started; answers 503 while draining. Each
check has `ANONIFY_READY_TIMEOUT_MS` (default 2000), and the answer is cached
for one second.

- **Auth:** none
- **Params:** none
- **Response `200`:** `{ status: "ready", checks: { database, storage, world? } }`,
  each the milliseconds the check took.
- **Response `503`:** `{ status: "not-ready", failed: [...] }`, the names of the
  checks that failed (`database`, `storage`, `world`, `draining`) and nothing
  else; the detail is logged with `context: "health.ready"`.
