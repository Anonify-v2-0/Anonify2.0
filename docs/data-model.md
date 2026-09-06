# Data model

`prisma/schema.prisma`

The database is Postgres, accessed through Prisma. It holds twelve models, and
almost everything in them is metadata about bytes that live elsewhere: the
source file, the normalized model, every export and every report are all sealed
in blob storage and addressed by key. The columns here point at them, checksum
them, and record what was decided — they almost never hold the document's text.

A few properties are worth keeping in mind before reading the tables:

- **Extraction text never sits in the database in the clear.** The normalized
  model is encrypted and stored outside the row (`normalizedBlobKey`). `Redaction.text`
  is an exception, and only because a suggestion the reviewer has not accepted
  yet still needs to be shown.
- **The row is the record.** A durable run's progress lives on its row, not in
  the response that started it, so a window that closes and reopens reads the
  same truth as the one that began the work.
- **Charges are idempotent by writing the fact of having charged back onto the
  row that produced them.** A retried step reads its own row before deciding
  whether to charge again.
- **A batch owns decisions, not processing.** Each document keeps its own run,
  its own quota and its own failure; the batch is only what makes a decision
  taken in one of them apply to the others.

---

## 1. Entity-relationship overview

```
                         ┌──────────────────────┐
                         │       Setting        │  key → JSON value
                         │  (rate-limit CLI)    │
                         └──────────────────────┘

                         ┌──────────────────────┐
                         │      RateLimit       │  token bucket
                         │  key → tokens, ts    │
                         └──────────────────────┘

                         ┌──────────────────────┐
                         │     UsageRecord      │  daily quota, per fingerprint
                         │  fingerprint + date  │
                         └──────────────────────┘

  ┌──────────┐  1—N   ┌────────────────┐  1—N   ┌────────────────────┐
  │  Batch   │◀───────│   Document     │────────▶│  Redaction         │
  │          │        │  (parent ◀──┐) │        └────────────────────┘
  │          │        │             │  │  1—N   ┌────────────────────┐
  │          │        │             │  │────────▶│  GlobalRule        │
  └────┬─────┘        │             │  │        └────────────────────┘
       │ 1—N          │             │  │  1—N   ┌────────────────────┐
       ▼              │             │  │────────▶│  ProcessingEvent   │
  ┌──────────┐        │             │  │        └────────────────────┘
  │BatchRule │        │             │  │  1—N   ┌────────────────────┐
  └──────────┘        │             │  │────────▶│  ExportArtifact    │
       │ 1—N          │             │  │        └────────────────────┘
       ▼              └──────┬──────┘  │
  ┌──────────┐    N—1 (self) │  1—N   ┌────────────────────┐
  │BatchExport│◀─────────────┘────────▶│      AiUsage       │
  └──────────┘   "Attachments"         └────────────────────┘
                 (parentDocumentId,
                  sourcePartPath unique)
```

A `Document` is the hub. Most other tables hang off `documentId` and cascade on
delete, so a document that is purged takes its redactions, rules, events,
exports and AI usage with it. `Batch` sits to the side: it groups documents for
review decisions without coupling their processing. `Setting`, `RateLimit`,
`UsageRecord` and `AiUsage` are operational tables that do not relate to a
document by foreign key (though `AiUsage` carries an unenforced `documentId`
for telemetry).

The `Document` → `Document` self-relation named `"Attachments"` is the one that
deserves a second look — see §3.

---

## 2. `Document`

An uploaded source document. The stored source bytes are AES-256-GCM encrypted;
`checksum` is a SHA-256 integrity hash, never a key.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Document identifier. |
| `createdAt` | `DateTime` `@default(now())` | Row creation. Retention is capped at 72 h from this. |
| `updatedAt` | `DateTime` `@updatedAt` | Touched on every write. |
| `expiresAt` | `DateTime` | When the cleanup sweep may purge it. |
| `ttlSeconds` | `Int` `@default(86400)` | Retention window length, in seconds. |
| `originalName` | `String` | Filename the browser supplied. |
| `kind` | `String` | Sniffed format kind (pdf, docx, xlsx, …). |
| `mimeType` | `String` | Sniffed MIME type. |
| `size` | `Int` | Source byte count. |
| `pageCount` | `Int?` | Filled during extraction; null until known. |
| `status` | `String` `@default("queued")` | `queued \| extracting \| normalizing \| analyzing \| ready \| failed \| expired`. |
| `preset` | `String?` | Named detector set the analysis ran with. Null means everything was looked for — a missing preset must never narrow the sweep. See `lib/redaction/presets.ts`. |
| `error` | `String?` | User-facing failure sentence from `lib/workflows/failure.ts`. Never a raw thrown message. |
| `errorCode` | `String?` | Stable failure code. Retry decisions read this rather than re-parsing the sentence. |
| `sourceBlobKey` | `String?` | Sealed source bytes. Set once ingest has re-sealed the upload. |
| `uploadBlobKey` | `String?` | Plaintext client-upload landing spot; deleted as soon as ingest re-seals it. |
| `processedBlobKey` | `String?` | Sealed export artifact produced on demand. |
| `workflowRunId` | `String?` | Durable run currently processing (or last processing) this document. |
| `encryptionKey` | `String?` | Wrapped per-document data key (base64); unwrapped server-side only. |
| `checksum` | `String?` | SHA-256 of the sealed source bytes. Integrity, not a key. |
| `processedChecksum` | `String?` | SHA-256 of the export artifact, for verification on download. |
| `batchId` | `String?` | Batch this document arrived in, if any. `onDelete: SetNull`. |
| `parentDocumentId` | `String?` | The message this document was pulled out of as an attachment. Provenance only. `onDelete: Cascade`. |
| `sourcePartPath` | `String?` | Dotted MIME-part path (`0.3`) the attachment bytes came from. Path, not filename: filenames collide, get redacted, and only the path is unique and stable. |
| `userFingerprint` | `String` | Hashed owner identity. A document belongs to this and nothing else. |
| `quotaKey` | `String?` | Hashed quota bucket (session + coarse network); charged after extraction when the real count is known. |
| `normalizedBlobKey` | `String?` | Encrypted normalized-model artifact. Text never sits in the DB in the clear. |
| `metadata` | `Json?` | Free-form per-document metadata. See §10 for the known keys. |
| `redactions` | `Redaction[]` | Relation. |
| `rules` | `GlobalRule[]` | Relation. |
| `events` | `ProcessingEvent[]` | Relation. |
| `exports` | `ExportArtifact[]` | Relation. |
| `batch` | `Batch?` | Relation via `batchId`. |
| `parent` | `Document?` | Self-relation `"Attachments"`, via `parentDocumentId`. |
| `attachments` | `Document[]` | Inverse side of the `"Attachments"` self-relation. |

Indexes and constraints:

- `@@index([userFingerprint])` — list a session's documents.
- `@@index([expiresAt])` — the cleanup sweep reads by expiry.
- `@@index([batchId])` — batch membership.
- `@@index([parentDocumentId])` — children of a message.
- `@@unique([parentDocumentId, sourcePartPath])` — **one child per part.** Enforced
  by the database rather than by the step that writes it. Expansion is retried
  like every other step and re-parses the message from scratch; this is what
  makes a second pass unable to produce a second copy of the same attachment.

---

## 3. The `Batch` → `Document` → `Attachment` self-relation

A message that carries attachments in supported formats is expanded into a
batch: the message is one document, each supported attachment is another. The
children are first-class documents — their own run, their own quota, their own
failure, their own export — and nothing downstream branches on `parentDocumentId`
being set. The relation is provenance only.

Two columns carry the provenance:

- `parentDocumentId` — the message the bytes came from.
- `sourcePartPath` — the MIME part path (`0.3`), not the filename.

The path is what makes expansion idempotent. Expansion is a `"use step"` between
ingest and extraction, and like every step it is retried: on a storage blip or a
cold worker it re-parses the message from scratch and would, without a guard,
write a second row for the same attachment. The `@@unique([parentDocumentId,
sourcePartPath])` constraint makes the database refuse that second row, so a
retry converges on the existing child rather than duplicating it. Filenames
cannot do this job: they collide, they get redacted, and only the part path is
actually unique and actually stable.

If the `.eml` arrived on its own, a batch is created for it; if it arrived in a
batch already, the children join that one, so a reviewer's decision spans the
whole. See [pipelines.md](./pipelines.md) §EML.

---

## 4. `Batch`

Documents uploaded and reviewed as one pass. A batch owns decisions, not
documents: each document keeps its own run, its own quota accounting and its own
failure, and the batch is only what makes a decision taken in one of them apply
to the others.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Batch identifier. |
| `createdAt` | `DateTime` `@default(now())` | Row creation. |
| `userFingerprint` | `String` | Hashed owner. |
| `documents` | `Document[]` | Relation. `onDelete: SetNull` on the child side. |
| `rules` | `BatchRule[]` | Relation. Cascades. |
| `exports` | `BatchExport[]` | Relation. Cascades. |

Index: `@@index([userFingerprint])`.

---

## 5. `BatchRule`

A decision carried across a batch: "this value is a subject wherever it appears
in these files". It is materialized into a per-document `GlobalRule` for every
document in the batch, including ones that finish processing after the decision
was made.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Row id. |
| `batchId` | `String` | Owning batch. |
| `createdAt` | `DateTime` `@default(now())` | When the reviewer decided. |
| `pattern` | `String` | The value as the reviewer saw it. |
| `normalizedPattern` | `String` | Normalized form used for matching across documents. |
| `category` | `String` | Redaction category the decision assigns. |
| `originDocumentId` | `String?` | Where the reviewer made the decision, so the interface can say so. |
| `batch` | `Batch` | Relation via `batchId`, `onDelete: Cascade`. |

Index: `@@index([batchId])`.

### Batch owns decisions, not processing

`BatchRule` is the batch-wide form of a decision; `GlobalRule` is the
per-document materialization of it. A batch rule is created when the reviewer
says "this name is a colleague in all of these files", and every document in the
batch — including ones still being processed — gets a `GlobalRule` row copied
from it. The batch never couples the documents' runs: one failing leaves the
others alone, and a document that finishes after the decision was made still
picks it up. The `enabled` flag lives on the per-document copy, so a reviewer
can turn a rule off for one file without affecting the others.

---

## 6. `GlobalRule`

A rule applied to one document. Either created directly for that document, or
materialized from a `BatchRule` (in which case `batchRuleId` is set).

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Row id. |
| `documentId` | `String` | Document this rule applies to. |
| `createdAt` | `DateTime` `@default(now())` | Row creation. |
| `pattern` | `String` | The value as the reviewer saw it. |
| `normalizedPattern` | `String` | Normalized form used for matching. |
| `category` | `String` | Redaction category. |
| `enabled` | `Boolean` `@default(true)` | Off means the rule is retained but does not produce redactions. This is the per-document switch. |
| `batchRuleId` | `String?` | Set when this rule is one document's copy of a batch-wide decision. |
| `document` | `Document` | Relation via `documentId`, `onDelete: Cascade`. |

Index: `@@index([documentId])`.

---

## 7. `BatchExport`

A durable run that exports every document in a batch. The run is the record: a
batch export is minutes of work that outlives the request that asked for it —
the browser can be closed, the function that started it can be recycled — so its
progress lives here rather than in the response stream, and any later reader can
say exactly where it got to.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Row id. |
| `batchId` | `String` | Owning batch. |
| `createdAt` | `DateTime` `@default(now())` | Row creation. |
| `updatedAt` | `DateTime` `@updatedAt` | Touched after each document settles. |
| `status` | `String` `@default("queued")` | `queued \| running \| ready \| failed \| cancelled`. |
| `workflowRunId` | `String?` | The durable run doing the work. |
| `total` | `Int` `@default(0)` | Documents in the batch at start. |
| `completed` | `Int` `@default(0)` | Documents settled either way, so progress is honest about skips. |
| `exported` | `Int` `@default(0)` | Documents that actually produced an artifact. |
| `documents` | `Json?` | Per-document state array — see below. |
| `options` | `Json?` | Export options the run was started with. |
| `networkKey` | `String?` | Hashed network bucket, so each document is charged the export allowance it would have been charged on its own. |
| `cancelRequested` | `Boolean` `@default(false)` | Set by the reviewer; the run stops at the next document boundary. |
| `error` | `String?` | User-facing sentence. Never a raw thrown message. |
| `batch` | `Batch` | Relation via `batchId`, `onDelete: Cascade`. |

Indexes: `@@index([batchId])`, `@@index([batchId, status])`.

### `documents` JSON — the progress UI's source of truth

`documents` is a JSON array with one entry per document in the batch. Each entry
carries the document's name, its current state, and the reason it was skipped if
it was. The totals (`completed`, `exported`) are recomputed from these states
rather than incremented, because a retried step would otherwise count twice.
Names only — nothing about what was found in any of them. The batch export
stream relays whole snapshots of this array as SSE frames, so a client that
drops and reconnects picks up at the event after the last one it saw; if the
stream cannot be held open at all, the client falls back to reading the row
every five seconds. See [workflow.md](./workflow.md) §5.

---

## 8. `Redaction`

A single redaction on a single document. The central table: detection produces
rows with `status: "suggested"`, the reviewer accepts or rejects, and the
exporter filters on `status === "accepted"` — and nothing else.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Row id. |
| `documentId` | `String` | Owning document. |
| `createdAt` | `DateTime` `@default(now())` | Row creation. |
| `source` | `String` | Which detector or source proposed it. |
| `type` | `String` | Redaction type (text, region, cell, …). |
| `category` | `String` | Entity category (person, email, …). |
| `confidence` | `Float?` | Detector confidence, when applicable. |
| `status` | `String` `@default("suggested")` | `suggested \| accepted \| rejected`. The exporter reads `accepted` only. |
| `method` | `String?` | What accepting this does to the bytes: `mask \| pseudonymize \| tokenize \| encrypt`. Null means `mask`, which is what every redaction taken before methods existed did. Stored, not trusted — whether a method is *allowed* is decided by `lib/redaction/methods.ts` and asked again at export time, so a method that stops being defensible resolves to a mask. |
| `page` | `Int?` | Page index for paginated formats. |
| `text` | `String?` | The matched text. Shown to the reviewer before a decision. |
| `startOffset` | `Int?` | Start offset into the page's flat text stream. |
| `endOffset` | `Int?` | End offset. |
| `worksheet` | `String?` | Sheet name for grid formats. |
| `row` | `Int?` | Row index for grid formats. |
| `column` | `Int?` | Column index for grid formats. |
| `reason` | `String?` | Optional human-readable reason. |
| `ruleId` | `String?` | When produced by a rule, the rule's id. |
| `metadata` | `Json?` | Free-form per-redaction metadata. |
| `document` | `Document` | Relation via `documentId`, `onDelete: Cascade`. |

Indexes: `@@index([documentId])`, `@@index([documentId, status])`.

---

## 9. `ProcessingEvent`

An append-only event log per document. Written by the workflow steps and read
back as the SSE stream the workspace follows.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Row id. |
| `documentId` | `String` | Owning document. |
| `at` | `DateTime` `@default(now())` | When the event fired. |
| `type` | `String` | Event type (e.g. `document.queued`, `document.ai.progress`). |
| `payload` | `Json?` | Event-specific counts, durations, stages. Never document text. |
| `document` | `Document` | Relation via `documentId`, `onDelete: Cascade`. |

Index: `@@index([documentId, at])` — the stream reads the tail in time order.

---

## 10. `Document.metadata` JSON

`Document.metadata` is a free-form JSON column, but the pipeline writes a known
set of keys into it. These are the ones that matter:

| Key | Type | Purpose |
| --- | --- | --- |
| `quotaCharged` | `boolean` | **The idempotent charge mark.** Set to `true` in the same transaction as the `UsageRecord` increment. A retried extraction reads this before deciding whether to charge again, so a step that failed after charging and succeeded on retry is not billed twice for one upload. See `chargeDocumentUsage`. |
| `ocrPages` | `number` | Pages in a PDF that were rasterized and read by OCR rather than read as born-digital text. A scanned page is not a blank page. |
| `imageClass` | `string` | For images: `document \| photograph \| mixed`, from the ratio of text area to image area. Changes what the editor offers. |
| `preset` | `string` | The named detector set used, mirrored from the `preset` column when present. |
| `width` | `number` | For images: pixel width of the source. |
| `height` | `number` | For images: pixel height of the source. |
| `format` | `string` | For images: the image format as detected (jpeg, png, …). |

Anything not listed here is format-specific scratch the pipeline wrote for its
own use and should not be relied on.

---

## 11. `ExportArtifact`

A generated export. Kept encrypted, addressed only by signed token.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Row id. |
| `documentId` | `String` | Owning document. |
| `createdAt` | `DateTime` `@default(now())` | When the export was produced. |
| `blobKey` | `String` | Encrypted artifact in blob storage. |
| `checksum` | `String` | SHA-256 of the artifact; re-verified on download. |
| `mimeType` | `String` | Output MIME type. |
| `extension` | `String` | Output file extension. |
| `size` | `Int` | Artifact byte count. |
| `appliedRedactions` | `Int` `@default(0)` | Count of accepted redactions actually applied to produce this artifact. |
| `metadataSanitized` | `Boolean` `@default(false)` | Whether EXIF/GPS and other metadata was stripped. On for images when the option is set. |
| `labelsAdded` | `Boolean` `@default(false)` | Whether redaction labels were added to the output. |
| `variant` | `String?` | Which output of one review this is, when the reviewer asked for more than one. Null means the single default output. The name is derived from the methods the variant applied, never typed by the reviewer — it reaches the export report, which must carry no free strings. See `lib/redaction/variants.ts`. |
| `reportBlobKey` | `String?` | The export report generated with this artifact: counts, styles and both checksums, stored encrypted beside the file it describes. Null for artifacts exported before reports existed. |
| `vaultBlobKey` | `String?` | The token vault for this artifact, **written only by a batch export**. A single export hands its vault back in the response and stores nothing, which is what makes an `encrypt` export unreversible by this tool; a batch run is collected as a zip minutes later and has no response to hand it back in, so the vault is sealed under the same per-document key and purged by the same sweep. Within that window the source document is already in the same bucket under the same key, so this grants nothing that was not already available. |
| `vaultChecksum` | `String?` | SHA-256 of the vault blob. Re-checked when the archive is assembled; a mismatch leaves the vault out rather than shipping half a mapping. |
| `reportChecksum` | `String?` | SHA-256 of the report blob. |
| `document` | `Document` | Relation via `documentId`, `onDelete: Cascade`. |

Index: `@@index([documentId])`.

---

## 12. `UsageRecord`

Per-fingerprint daily quota accounting. Enforced server-side only.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Row id. |
| `fingerprint` | `String` | Hashed quota bucket (session + coarse network). |
| `date` | `DateTime` `@db.Date` | The day, in UTC. Allowance resets at midnight UTC. |
| `pdfPages` | `Int` `@default(0)` | PDF pages processed. |
| `xlsxCells` | `Int` `@default(0)` | Filled cells across every grid format: XLSX, CSV and TSV. |
| `images` | `Int` `@default(0)` | Images processed. |
| `docxPages` | `Int` `@default(0)` | DOCX pages processed. |
| `textPages` | `Int` `@default(0)` | Pages of extracted text, for plain text and RTF. |
| `emailKilobytes` | `Int` `@default(0)` | Kibibytes of decoded text pulled out of a message: headers, every text part, every nested message. An email is not a page. |
| `pptxSlides` | `Int` `@default(0)` | Slides in a deck. Notes, layouts and masters are processed with the slide they belong to. |
| `uploads` | `Int` `@default(0)` | Documents uploaded. Pre-checked at reservation. |

Constraint: `@@unique([fingerprint, date])` — one row per fingerprint per day,
so an increment is an upsert rather than an insert-or-accumulate.

Quota units differ because the work does; see [pipelines.md](./pipelines.md).
Counting an email as a page would charge a one-line reply the same as a
forwarded thread.

---

## 13. `AiUsage`

AI cost/telemetry per processing job. Never stores document content.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `id` | `String` `@id` | Row id. |
| `documentId` | `String` | Document the job was for. Indexed but not a foreign key — telemetry survives nothing load-bearing. |
| `createdAt` | `DateTime` `@default(now())` | When the job ran. |
| `task` | `String` | What the model was asked to do (e.g. `detect`, `vision`). |
| `model` | `String` | Which model was used. |
| `inputTokens` | `Int` `@default(0)` | Prompt tokens in. |
| `outputTokens` | `Int` `@default(0)` | Completion tokens out. |
| `durationMs` | `Int` `@default(0)` | Wall-clock duration of the model call. |
| `chunks` | `Int` `@default(1)` | Number of chunks the document was split into for this call. |

Index: `@@index([documentId])`.

---

## 14. `Setting`

Runtime settings that survive a restart and can be changed without editing
source or redeploying — the rate-limit CLI writes here.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `key` | `String` `@id` | Setting name. |
| `value` | `Json` | The setting's value, as JSON. |
| `updatedAt` | `DateTime` `@updatedAt` | Last write. |

A single-row key/value table. There is no schema on `value` beyond JSON; the
reader and the CLI agree on the shape per key. The rate-limit CLI is the
canonical writer: it reads the current limits, lets an operator adjust them, and
writes the result back, so a change takes effect on the next request without a
redeploy.

---

## 15. `RateLimit`

Token-bucket rate limiting, keyed by hashed network/session identifiers. A
bucket refills continuously, so there is no window boundary to burst across the
way a fixed window allows.

| Column | Type | Purpose / notes |
| --- | --- | --- |
| `key` | `String` `@id` | Hashed identifier (network key, quota key, …). |
| `tokens` | `Float` | Current token count. Float because refill is continuous — a bucket is not whole tokens. |
| `updatedAt` | `DateTime` | When the bucket was last touched. Refill is computed from the elapsed time since this, on the next read. |

Index: `@@index([updatedAt])` — the cleanup sweep prunes stale buckets.

The bucket is persisted rather than held in memory, so a restart does not reset
everyone's allowance and two instances see the same count. A request reads the
row, computes the refill since `updatedAt`, subtracts the cost, writes both back
in a transaction; if the result is below zero the request is refused.
