# Anonify

AI-assisted document redaction. Upload a PDF, DOCX, XLSX or image; the system
proposes what looks sensitive; you decide; the export removes it.

The governing rule: **AI proposes, the application applies, and only what a
person accepted is removed.** A beautiful editor that leaves the original text
under a black rectangle is not a redaction system.

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
```

### Redaction is removal, not concealment

- **PDF** — a page with accepted redactions is rendered to pixels with the boxes
  burned in and rebuilt from that raster. There is no way to paint over text in
  a PDF and have it be gone. Pages without redactions are copied through and
  keep their selectable text.
- **DOCX** — the text nodes that carry the characters are edited in place, so
  styles, numbering and relationships survive byte-identical. A package-wide
  sweep covers headers, footers, footnotes and comments.
- **XLSX** — cells are rewritten, and any formula still referencing a redacted
  address is dropped, because a cached result is a second copy of the value.
- **Images** — pixels are replaced and the file re-encoded. EXIF and GPS go too.

Every export is then re-opened and read the way an adversary would. A surviving
value fails the export rather than shipping (`lib/redaction/validation.ts`).

### Cost discipline

Deterministic detectors run first: email, phone, Luhn-checked cards,
structurally valid SSNs, IBANs, credentials, and label-gated dates and account
numbers. The model is asked only the contextual question, once per chunk. A
value judged sensitive once is expanded to all its occurrences by local search —
occurrence 2..n costs a string scan, not a request.

## Running it

```bash
pnpm install
pnpm dev
```

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon PostgreSQL (pooled) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob. Required — uploads go browser → Blob |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway |
| `AI_MODEL` | Optional; defaults to `anthropic/claude-haiku-4.5` |
| `ENCRYPTION_KEY` | 32 bytes, base64 or hex. Master key for envelope encryption |
| `FINGERPRINT_SECRET` | 32 bytes. Salts the anonymous identity and signs downloads |
| `CRON_SECRET` | Set by Vercel; gates the expiry sweep |

Then push the schema:

```bash
pnpm db:push
```

Without `AI_GATEWAY_API_KEY` the pipeline still runs — deterministic detection,
manual redaction and export all work; only the contextual pass is skipped.

## Commands

```bash
pnpm dev         # development server
pnpm build       # production build
pnpm test        # unit, integration and adversarial suites
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm db:push     # apply the Prisma schema
```

## Tests worth knowing about

- `tests/security.test.ts` — takes each exported artifact and tries to get the
  sensitive value back out: PDF text extraction, raw byte scans with glyph
  spacing stripped, annotation objects, every OOXML part, hidden sheets and
  rows, cached formula results, the shared string table, sampled pixels, EXIF.
- `tests/export.test.ts` — end-to-end redaction per format, including that a
  *suggestion* the user never accepted is still present in the output.
- `tests/detectors.test.ts` — that an order number is not reported as a card,
  and a date is only a birth date when it is labelled as one.

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
  source, the normalized model, every export and every row.
- Logs carry ids, stages, durations and error categories. Never document
  content, never prompts, never keys.
