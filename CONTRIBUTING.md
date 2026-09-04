# Contributing to Anonify

Anonify is a document redaction tool you can clone, run, and read end to end.
This document explains what it is trying to be, the rules that keep it honest,
and what the next phase of work actually is — including an audit of the places
where the current code is half-finished.

---

## 1. What we are building

> **The value you accepted is not in the file you downloaded.**

That is the entire product. Everything else — the editor, the model, the
streaming, the design — exists to make that sentence true and to make it
checkable by someone who does not trust us.

A tool that draws a black rectangle over live text is not a redaction tool. It
is an expensive screenshot with a lie attached, and people have leaked real
information believing otherwise. If you only read one section of this file, make
it the next one.

### The invariants

These are not preferences. A change that breaks one of them will not be merged,
however good the rest of it is.

| # | Invariant | Why |
| --- | --- | --- |
| 1 | **The source file is never mutated.** | A bad redaction must be a bad *export*, never a lost document. |
| 2 | **Only `status === "accepted"` reaches the exporter.** | Detection proposes. A person decides. There is no code path where a detector's output is applied on its own. |
| 3 | **Redaction removes; it never covers.** | No overlay, no white text, no annotation that can be deleted. |
| 4 | **Every export is verified before delivery.** | Re-open the artifact, read it adversarially, refuse it if an accepted value survived. |
| 5 | **A model's output is located, never trusted.** | It returns text it claims to have seen; we find that text in the source ourselves and discard what we cannot locate. |
| 6 | **Nothing logs document content.** | Not prompts, not extracted text, not OCR output, not keys. Ids, stages, durations, error categories. |
| 7 | **SHA-256 is not encryption.** | It is used for integrity and HMAC. Encryption is AES-256-GCM with random keys. |
| 8 | **Keys are random.** | Never derived from an IP, a MAC, browser behaviour, or anything else an attacker controls. |

If you find a way to violate one of these that the tests do not catch, that is a
**security issue and a welcome contribution** — open an issue and, ideally, a
failing test.

---

## 2. Design positions

Things people reasonably ask for that we are deliberately not doing.

### No accounts, no auth

This repo is meant to be **cloned and run on your own machine**, against your own
database and your own storage. There is no login because there is nobody else on
your instance.

The hosted demo exists so people can experience the tool without setting it up.
It is anonymous by design: a server-issued session cookie is the identity, and
whoever holds it owns those documents. That is appropriate for a temporary demo
and inappropriate for a multi-tenant product — which is fine, because it is not
one.

If you need multi-user with real identities, fork it. Ownership already flows
through one function (`requireDocument`), so swapping the identity source is a
small change. We are not carrying that complexity in the main line.

### No telemetry that leaves the machine

Usage counters are local rows in your own database. Nothing phones home.

### No vendor lock-in that breaks local dev

Vercel Blob, Neon and the AI Gateway are the *deployed* defaults, not
requirements. A clone runs against local Postgres, local MinIO and local
Tesseract with no account anywhere, and CI proves it on every pull request by
booting that stack and redacting a document through it. If you find a code path
that only works on Vercel, that is a bug — report it as one.

---

## 3. The next phase

Ordered by how much they unblock. Each item says where the code is and what
"done" looks like.

### 3.0 Project files

Done.

- [x] ~~**Add a `LICENSE`.**~~ [Apache-2.0](LICENSE), chosen for the explicit
      patent grant: a redaction tool gets deployed inside organisations whose
      legal teams read the licence before anyone is allowed to contribute back.
- [x] ~~`CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates.~~
      [SECURITY.md](SECURITY.md) is the one worth reading — it says what counts
      as a vulnerability here, which is a narrower and stranger set than usual,
      and it asks you not to publish a bypass before there is a fix.

### 3.1 Make it actually clone-and-run

Done. A fresh clone now runs with `pnpm setup && docker compose up -d`, which
builds and starts Anonify along with local Postgres and MinIO, with no account
anywhere.

- [x] ~~**Browser uploads require a real Blob store.**~~ The server reports which
      upload mode is configured and the client follows; `/api/upload/local`
      handles everything that is not Vercel Blob, writing through the same
      storage abstraction.
- [x] ~~**The database adapter is hardcoded to Neon.**~~ `postgres` or `neon`,
      inferred from the connection string, overridable with `DATABASE_DRIVER`.
      PGlite was investigated and dropped: there is no Prisma 7 adapter for it.
- [x] ~~**No migrations.**~~ Migrations are canonical, and CI applies them to an
      empty database and fails if the schema and the migrations disagree.
- [x] ~~**A `docker compose` for the dependencies.**~~ Postgres and MinIO, with
      health checks, named volumes and automatic bucket creation.
- [x] ~~**A container image for the app itself.**~~ A standalone Next.js build on
      `node:22-slim`, with a separate migrator stage that runs before the app
      starts, and durable runs backed by `@workflow/world-postgres` rather than
      Vercel's world.
- [x] ~~**`engines` and `packageManager`.**~~ Node 22+, pnpm 11+, enforced by
      `engine-strict`.
- [x] ~~**Verify the compose stack in CI.**~~ A `Compose stack` job builds the
      images, waits for every health check, and then runs `pnpm smoke` — a real
      upload, process, accept, export and download over HTTP, ending by reading
      the downloaded bytes and failing if an accepted value is still in them.
      It runs on every pull request, not only on Dockerfile changes, because
      every failure it has caught so far came from application code meeting the
      container rather than from Docker.

### 3.2 Finish what is half-wired

Everything in this section has landed. Kept as a record of what "half-wired"
meant, because the same shape recurs: a capability built end to end except for
the last connection, which passes review precisely because each half looks
finished.

- [x] ~~**Scanned PDFs are detected and then ignored.**~~ Flagged pages are
      rasterized and read, and the words merged into the page model as spans
      with real geometry. `lib/documents/pdf/ocr.ts`.
- [x] ~~**Blur and pixelate are unreachable.**~~ Exposed in the export dialog,
      defaulting to solid, with the caveat stated where the choice is made.
- [x] ~~**AI cost is recorded and never shown.**~~ Per-document breakdown in the
      export dialog, session aggregate on the documents page. Cost appears only
      when rates are configured — see [§4](#4-benchmarks).
- [x] ~~**Page thumbnails are blank rectangles.**~~ Real renders with accepted
      redactions drawn on, so the rail doubles as a progress view.
- [x] ~~**DOCX headers and footers are swept but not reviewable.**~~ Every
      text-bearing part is extracted and rendered, which required addresses to
      be part-qualified (`word/header1.xml#p0r0`).
- [x] ~~**XLSX has no equivalent of the DOCX part sweep in the UI.**~~ Sheet
      visibility is extracted (`hidden` and `veryHidden` are different problems
      — the second cannot be undone from Excel's own menu) and the grid says so:
      a banner above the sheet, a marker on its tab, and a count of the hidden
      rows and columns within it.
- [x] ~~**Image OCR text is not offered as suggestions.**~~ It was being
      detected all along — `analyzeDocument` runs the detectors over every
      page's text, and an image's page text *is* its OCR. What was missing was
      placement: a text detection carries offsets, not a rectangle, so the
      suggestions existed in the database and appeared nowhere on the image. The
      canvas now resolves them through the OCR span geometry with the same
      `boxesForRedaction` the exporter uses, and OCR words became what they
      always should have been — hit targets, not a hundred dashed proposals.

### 3.3 Testing

Zero coverage today for: `extractImage`, `ocrImage`, `analyzeDocument`,
`analyzeImageRegions`, `cleanupExpired`, `runStructured`.

- [ ] **A fake model provider** so the analysis orchestration can be tested
      without a network or a bill — chunking, concurrency, dedupe, the
      locate-or-discard rule, and the "provider failed, keep going" path.
- [ ] **Cleanup and quota tests**, which need a database. Either a test Postgres
      in CI or PGlite; the latter also serves [3.1](#31-make-it-actually-clone-and-run).
- [ ] **OCR tests** with a committed fixture image and pinned language data, so
      they do not depend on a download.
- [ ] **End-to-end tests** (Playwright): upload → review → export → download,
      per format, through the browser. `pnpm smoke` now does this over HTTP for
      a PDF and runs in CI against the compose stack, which covers the wiring
      but not the editor — nothing yet drives the canvas, the inspector or the
      export dialog.
- [ ] **Adversarial tests for formats we do not yet handle** — see 3.5.

### 3.4 Depth on what exists

- [ ] **PDF: preserve the text layer.** Today a page carrying a redaction is
      rasterized, which guarantees removal but loses selectable, searchable,
      screen-reader-accessible text. Content-stream surgery — removing the
      specific text-showing operators — would keep it. This is genuinely hard
      across arbitrary fonts and encodings, and *nearly* right means leaking, so
      it must land behind the same verification gate and a lot of tests. High
      value, high difficulty.
- [x] ~~**Accessibility.**~~ Canvas redactions are labelled, focusable and
      carry `aria-pressed`; the per-word hit targets are out of the tab order
      because a page of prose as hundreds of tab stops is worse than none; the
      inspector is a real list whose rows are buttons; a live region reports
      where the review stands. Still open: a screen-reader pass by someone who
      actually uses one, and colour-contrast verification.
- [ ] **Non-English detection.** Detectors are English-shaped (`DOB`, `Account`,
      street suffixes) and prompts are English. Locale-aware patterns and
      per-language prompt variants.
- [ ] **Touch.** Region drawing works with a pointer; it should work with a
      finger.
- [x] ~~**Rate limiting is a fixed window.**~~ Now a token bucket, refilling
      continuously, so there is no boundary to burst across.
      `lib/security/token-bucket.ts`.

### 3.5 New surface

Only after the invariants hold for it, including an adversarial test suite.

- [ ] **More formats:** PPTX (the same OOXML approach as DOCX — speaker notes are
      a lovely hiding place), CSV/TSV, plain text, RTF, EML.
- [ ] **An export report** — what was removed, by category and count, with the
      checksum — as a separate artifact.
- [ ] **Batch upload**, with review carried across documents.
- [ ] **Redaction presets** ("GDPR", "HIPAA-shaped", "engineering secrets") as
      named detector + category sets. Presets must not imply compliance; naming
      here needs care.

---

## 4. Benchmarks

**We want this and we do not have it.** The architecture makes a specific,
falsifiable claim, and nobody has measured it:

> Running deterministic detectors first, then asking a model only the contextual
> question, and expanding repeated values by local search, costs dramatically
> fewer tokens than sending the document to a model — at comparable or better
> detection quality.

That could be wrong. Measuring it is one of the most useful things anyone can
contribute, and it does not require understanding the whole codebase.

### What to measure

The gateway exposes many models. `AiUsage` already records model, input tokens,
output tokens, duration and chunk count per task, so the substrate exists.

**Cost and throughput**
- Tokens in / out per document, by model
- Cost per document (tokens × the model's published price)
- Wall-clock per stage: extract, normalize, analyze, export
- Documents per minute at a fixed concurrency
- How the numbers scale with page count and PII density

**Quality** — needs a labelled corpus, which is itself a contribution
- Precision and recall per category (email, person, address, account, …)
- False positives, weighted: a wrongly flagged word costs a click, a missed SSN
  costs a leak. These are not the same error.
- Agreement between models on the same document

**The architectural claim**
- Tokens with deterministic detectors on vs. off
- How much of the final result comes from regex, from the model, and from local
  expansion
- Model calls saved by expansion, as a function of how often values repeat

### The graphs we would like to see

1. **Cost per document by model** — bar chart, log scale, with page count held
   constant.
2. **Cost vs. quality frontier** — scatter, $ per document against F1, one point
   per model. The interesting question is where the knee is, and whether the
   expensive models are buying anything.
3. **Token savings from deterministic-first** — stacked bars, tokens with and
   without the regex pass, per document type.
4. **Throughput vs. concurrency** — line chart, where the provider's rate limit
   starts to bite.
5. **Per-category recall heatmap** — model × category. We expect small models to
   do fine on structured PII and worse on contextual judgement; that should be
   visible, and if it is not, the pipeline's premise is wrong.

Charts should be readable in both light and dark, colourblind-safe, and
reproducible from committed data — a PNG with no numbers behind it is an
opinion.

### How to submit one

1. Put the harness in `benchmarks/`, runnable with one command against a corpus
   directory.
2. **Do not commit real documents.** Use synthetic fixtures — `tests/fixtures.ts`
   is a starting point — or a public corpus, cited. Never a document containing
   somebody's actual personal data.
3. Commit the raw results as JSON alongside the chart, so a later run can be
   compared and the numbers can be checked:

```jsonc
{
  "model": "anthropic/claude-haiku-4.5",
  "corpus": "synthetic-invoices-v1",
  "commit": "abc1234",
  "documents": 50,
  "deterministicFirst": true,
  "totals": { "inputTokens": 412000, "outputTokens": 18400, "durationMs": 96000 },
  "perDocument": { "medianMs": 1840, "p95Ms": 3200 },
  "quality": { "precision": 0.94, "recall": 0.88, "byCategory": { "email": { "precision": 1, "recall": 1 } } }
}
```

4. Say what you *didn't* measure. A benchmark that reports only its flattering
   numbers is worse than none.

---

## 5. Working on the code

### Setup

```bash
pnpm setup                                  # writes .env and generates the two required secrets
docker compose up -d postgres minio minio-init
pnpm db:migrate
pnpm dev
```

`pnpm setup` asks whether you want the demo-compatible services or a fully local
install; the commands above are the local path. To run the whole thing in
containers instead, `docker compose up -d` and skip the rest.

`AI_GATEWAY_API_KEY` is genuinely optional — without it the contextual pass is
skipped and the deterministic detectors, manual redaction and export all still
work, which is a reasonable way to develop the UI and the only way CI runs.

### Before you push

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

CI runs these four in parallel, plus a migration check and a `Compose stack` job
that builds the images and runs `pnpm smoke` against them. They must pass.

If you have touched anything the container has to assemble — a native
dependency, the workflow runtime, storage, the Dockerfile — run that last one
yourself before pushing, because it is the slow one to find out about:

```bash
docker compose up -d --build --wait
pnpm smoke
docker compose down -v
```

`pnpm smoke` uploads a synthetic PDF, waits for the pipeline, accepts every
suggestion, exports, downloads the result and fails if an accepted value is
still in the bytes. It works against any running instance: `pnpm smoke
https://your-deployment`.

`pnpm typecheck` runs `next typegen` first. `RouteContext` and `PageProps` are
globals Next generates into `.next/types/`, so type checking a fresh clone
without generating them fails with "Cannot find name 'RouteContext'" — the
script generates them itself rather than depending on a build having happened.

### Where things live

`docs/architecture.md` explains the four-layer separation, `docs/workflow.md` the
durable pipeline, `docs/ai-engine.md` the detection order, and
`docs/pipelines.md` why each format's pipeline is shaped the way it is. Read the
one that covers your area first — most of these decisions have a reason, and the
reason is usually written down.

### Style

- **Comments explain why, not what.** The code says what it does. A comment
  earns its place by recording a decision, a constraint, or a trap — several
  comments in this codebase exist because a test caught a real bug and the next
  person deserves to know.
- Match the surrounding code. It is consistent; keep it that way.
- Keep processing logic out of React. Nothing in `lib/` imports a component,
  which is why the same code runs in a workflow step, a route handler, and a
  test against a real file.
- Prefer a simple implementation until a measurement says otherwise.

### Tests

A change to redaction behaviour needs a test that reads the produced artifact,
not one that asserts a function was called. The pattern is in
`tests/security.test.ts`: build a real file, redact it, then try to get the value
back out.

Three bugs in this codebase were found by tests written that way — sharp
silently ignoring a second `resize` so pixelation kept full detail, undo
snapshots aliasing an Immer draft so undo restored what it was meant to replace,
and pdf.js detaching a buffer so the next reader got nothing. None of them would
have been caught by mocking.

### Commits and PRs

- Explain **why** in the commit body. What changed is in the diff.
- One concern per PR.
- If you found a bug while doing something else, say so in the PR — that is the
  most valuable sentence in most changelogs.

---

## 6. Good first issues

Small, self-contained, and genuinely useful:

- A benchmark of two models on the synthetic fixtures (§4) — no need to
  understand the codebase, and it tests a claim nobody has checked
- Any test from §3.3 — the fake model provider is the highest-leverage one
- Touch support for drawing a region (§3.4)
- Locale-aware detectors for one language you actually speak (§3.4)
- Extend `pnpm smoke` to DOCX, XLSX and images: it only covers PDF today, and
  each format is a few lines and a fixture (`scripts/smoke.ts`)

And the one with the most leverage per line of code: **preserve the PDF text
layer** (§3.4) — hard, valuable, and the last place where removal costs the
user something real.
