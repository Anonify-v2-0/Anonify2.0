# Anonify

AI-assisted document redaction. Upload a PDF, DOCX, XLSX or image; the system
proposes what looks sensitive; you decide; the export removes it.

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
| **Formats** | PDF | PDF, DOCX, XLSX, images |
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

Each of these is argued through in [docs/pipelines.md](docs/pipelines.md).

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
  source, the normalized model, every export and every row. Retention can be
  extended, but the new expiry is computed from creation and capped at 72 hours,
  so renewing repeatedly converges on the ceiling rather than moving it.
- Logs carry ids, stages, durations and error categories. Never document
  content, never prompts, never keys.
