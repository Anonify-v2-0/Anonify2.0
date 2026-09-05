# Architecture

Anonify is an AI-assisted redaction tool. The design follows from one claim it
has to be able to make honestly:

> The value you accepted is not in the file you downloaded.

Everything below exists to make that claim true and to make it checkable.

---

## 1. The four layers

The system keeps four things separate, and most of its correctness comes from
refusing to blur them.

```
┌─ A ─ SOURCE ────────────────────────────────────────────────┐
│  The uploaded bytes. Sealed, checksummed, never mutated.     │
└──────────────────────────────┬───────────────────────────────┘
                               │ extract
┌─ B ─ NORMALIZED ─────────────▼───────────────────────────────┐
│  Pages, spans with geometry, runs, sheets, regions.          │
│  One vocabulary for every format.                            │
└──────────────────────────────┬───────────────────────────────┘
                               │ detect
┌─ C ─ REDACTIONS ─────────────▼───────────────────────────────┐
│  suggested → accepted / rejected.                            │
│  The record of intent. The only source of truth.             │
└──────────────────────────────┬───────────────────────────────┘
                               │ apply (A + accepted C)
┌─ D ─ OUTPUT ─────────────────▼───────────────────────────────┐
│  A new document. Verified, checksummed, then delivered.      │
└──────────────────────────────────────────────────────────────┘
```

| Layer | Lives in | Notes |
| --- | --- | --- |
| **A. Source** | Blob storage, AES-256-GCM | Never edited in place. Export always reads A, never D. |
| **B. Normalized** | `lib/documents/*`, `types/document.ts` | Also encrypted — it contains the document's text. |
| **C. Redactions** | `types/redaction.ts`, `lib/redaction/*` | Rows in Postgres. Detections become *suggestions*. |
| **D. Output** | `lib/redaction/export.ts` | Regenerated on demand; deterministic from A + C. |

### Why A and D never touch

The source is never modified, so a bad redaction is a bad *export*, not a lost
document. Re-export with different decisions and you get a different D from the
same A. This also means "undo" at the document level is free: nothing was
destroyed.

### Why C is separate from detection

A detector's output is a **proposal**. A redaction is a **decision**. Keeping
them as different words in different columns is what makes the human step real
rather than decorative — the exporter filters on `status === "accepted"` and
cannot be talked into anything else. A suggestion nobody accepted appears in the
export untouched, and there is a test asserting exactly that.

---

## 2. Request paths

```
BROWSER                    SERVER                      DURABLE RUN
   │
   │ POST /api/documents        reserve, quota, rate limit
   │──────────────────────────▶ creates row (status: uploading)
   │◀────────────────────────── { id, pathname }
   │
   │ POST /api/upload/token     validate path ownership
   │──────────────────────────▶ sign scoped token
   │◀────────────────────────── token
   │
   │ upload() ─────────────────────────────────▶ VERCEL BLOB
   │                                              (file never
   │                                               passes through
   │                                               a function)
   │
   │ POST /api/documents/:id/process
   │──────────────────────────▶ start(processDocument) ─────▶ ingest
   │◀────────────────────────── { runId }                     extract
   │                                                          normalize
   │ GET  /api/documents/:id/stream                           detect
   │══════════════════════════▶ SSE ◀═══════════════════════ progress
   │                                                          events
   │ (review: accept / reject / manual / rules)
   │
   │ POST /api/documents/:id/export
   │──────────────────────────▶ build plan → generate → VERIFY
   │◀────────────────────────── signed short-lived download URL
```

### Why uploads go browser → Blob

A serverless function has a request body limit and a duration budget; a 50 MiB
file has neither reason nor need to pass through one. The browser uploads
directly, which means the server never buffers the file and the progress bar
reflects the real transfer.

The cost is that the bytes land in storage before the server has seen them. The
pipeline's first step closes that window: it fetches them, sniffs what they
actually are, checksums, seals them under a fresh per-document key, and deletes
the plaintext upload. That short interval is the only time the file exists
unencrypted at rest, and it is stated plainly rather than glossed over.

### Why processing is a durable workflow

Extraction, OCR and model calls are slow and fail in uninteresting ways. Running
them inside a request means a timeout loses the work; running them in a
background promise means a cold start loses it silently.

Each stage is a `"use step"` function: retried independently, results persisted,
and the run resumes from the last completed step rather than the beginning. A
provider timing out costs a retry, never the upload. See
[workflow.md](./workflow.md).

Exporting a batch is a durable run for the same reason, with the same shape: one
step per document, progress on a row rather than in the response, so the work
survives the request that asked for it and the reviewer can close the window,
watch the progress from a button, or stop it.

---

## 3. Identity, without accounts

There are no accounts. Identity comes from a server-issued random session id in
an httpOnly cookie, and it is split into three derived keys — because the three
questions have different right answers:

| Key | Derived from | Answers |
| --- | --- | --- |
| `ownerKey` | session id | "Is this document yours?" |
| `quotaKey` | session id + coarsened IP | "Have you used your daily allowance?" |
| `networkKey` | coarsened IP | "Are you hammering this endpoint?" |

Ownership uses the session alone, so a document does not become unreachable when
the user's IP changes. Quota and rate limiting bring in the network, so clearing
a cookie does not hand out a fresh allowance. Addresses are coarsened to /24 and
/48 before hashing, and only the salted hashes are stored.

No browser fingerprinting, and no MAC addresses — a browser cannot expose one,
and a design that assumes otherwise is both insecure and simply wrong.

A document id alone never authorizes anything: every read re-derives the caller's
identity and compares. A document that exists but belongs to someone else is
reported as **404**, not 403, so ownership is not probeable by id.

---

## 4. Encryption

Envelope encryption, everywhere bytes are stored:

```
random 256-bit data key  ──seals──▶  document bytes      (AES-256-GCM)
                                     normalized model
                                     each export
        │
        └──sealed by──▶  master key (ENCRYPTION_KEY)  ──▶  stored in DB
```

Every document gets its own data key. The key is random — never derived from an
IP, a MAC, browser behaviour or network activity, all of which are attacker-
controlled and unstable. GCM means tampering is detected rather than silently
decrypted into garbage.

SHA-256 appears in this system in exactly three places, all of them hashing:
integrity checksums, identity derivation, and download-token signing (HMAC). It
is not encryption and is never used as though it were.

Blob URLs are treated as opaque server-side handles. They are never handed to a
client; downloads go through a route that re-checks ownership, verifies the
stored checksum, and only then streams bytes.

---

## 5. Verification as a gate

The exporters are tested, but a redaction tool should not take its own word for
it on the file it is about to hand back.

Every export is re-opened and read the way an adversary would — extracted PDF
text, every OOXML part, every sheet including hidden ones — and any accepted
value still present **fails the export**. The file is not saved, no download link
is issued, and the user is told the export was refused.

`tests/security.test.ts` is the same idea as a test suite: twenty-one attempts to
recover a redacted value from a produced artifact, all of which must fail.

---

## 6. Layout

```
app/
  page.tsx                     landing (static)
  documents/                   this session's documents
  workspace/[documentId]/      the editor
  api/
    documents/                 reserve, list
    documents/[id]/            read, extend, delete
      process/ stream/         start the run, read its events
      content/ source/         normalized model, decrypted bytes
      redactions/ rules/       the review record
      export/ download/        generate, then serve
    upload/token/              scoped client-upload tokens
    cron/cleanup/              expiry sweep

lib/
  ai/          gateway, prompts, schemas, orchestration
  documents/   formats.ts — the register every other list derives from
               pdf | docx | xlsx | image | csv/tsv | txt | rtf | eml | pptx
               ooxml/ — package access and run surgery, shared by docx + pptx
               shared/ — text streams, ranges, and the atom map RTF and the
               HTML inside an email both use
               purge, retention, detection of what a file actually is
  redaction/   detectors, entities, model, apply, validation, export
  security/    fingerprint, access-control, rate-limit, usage, signed-url
  storage/     drivers, blob, encryption, integrity
  workflows/   the durable pipeline, cleanup

store/         Redux Toolkit: document, redactions, editor, processing, ui
types/         the shared vocabulary
tests/         unit, integration, and the adversarial suite
```

Processing logic is independent of React. Nothing in `lib/` imports a component,
which is why the same extraction and export code runs in a workflow step, in a
route handler, and in a test against a real file.

---

## 7. Deliberate limits

Worth knowing before trusting this with something that matters:

- **Rasterized PDF pages lose their text layer.** A page carrying a redaction
  becomes an image, so it is no longer selectable or screen-reader accessible.
  This is the honest trade for actual removal; pages without redactions keep
  their text. See [pipelines.md](./pipelines.md).
- **Blur and pixelate are weaker than solid fill.** Both destroy the source
  pixels in the export, but heavily blurred content can in principle be attacked.
  Solid black is the default for that reason.
- **Detection is an assist, not a guarantee.** No detector finds everything. The
  reviewer is the control, which is why the UI never implies completeness.
- **The demo is anonymous.** Anyone with the session cookie is the owner. That is
  appropriate for a temporary demo and not for a multi-tenant product.
