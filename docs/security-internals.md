# Security internals

`lib/security/*`, `lib/redaction/report.ts`, `lib/redaction/presets.ts`

The architecture page states the invariants this system has to uphold — the
source is never mutated, only accepted redactions reach the exporter, every
export is verified. This page is for the mechanisms that hold those invariants
up in the small: the tokens that authorize a download, the check that a report
does not quote what it removed, the preset rule that narrows the model as well
as the regex pass, and the cookie that establishes ownership in the first
place. Each one is a place where the wrong-looking line of code is the leak.

---

## 1. Signed download tokens — `lib/security/signed-url.ts`

A stored artifact is never exposed by its storage URL. A download is
authorized by a token that names the document, the artifact and an expiry,
signed server-side with `FINGERPRINT_SECRET` — so a link cannot be edited into
one for another document, and it stops working on its own.

```ts
function sign(payload: string, domain = "download-url|"): string {
  return createHmac("sha256", requiredEnv("FINGERPRINT_SECRET"))
    .update(domain)
    .update(payload)
    .digest("base64url")
}
```

`signed-url.ts:14` — `DEFAULT_TTL_SECONDS = 300`. A token lives five minutes
from minting; `createDownloadToken` and `createBatchToken` both fall back to it
when no `ttlSeconds` is passed, and `verifyDownloadToken` / `verifyBatchToken`
reject anything whose `expiresAt` is in the past (`signed-url.ts:90`, `:131`).

### Domain separation

The two token kinds grant different things — one artifact versus a whole
archive — and a token that could be reinterpreted as the other is the kind of
mistake that only shows up once somebody tries. They are therefore signed
under **different HMAC domains** rather than being one token with a "type"
field in the payload:

| Token | Domain constant | Payload | Verifier |
| --- | --- | --- | --- |
| Document download | `"download-url|"` (the default) | `documentId.artifactId.ownerKey.expiresAt` | `verifyDownloadToken` (`signed-url.ts:84`) |
| Batch archive | `BATCH_DOMAIN = "batch-download-url|"` (`signed-url.ts:26`) | `batchId.ownerKey.expiresAt` | `verifyBatchToken` (`signed-url.ts:125`) |

Because the domain string is fed into the HMAC before the payload, a signature
made under one domain will not verify under the other. A batch token cannot be
substituted for a document token, and a document token cannot be passed to the
batch download route — the verifier for each calls `decode(token, domain)`
with its own domain, and the signature check fails before the payload is ever
interpreted (`signed-url.ts:33`).

### Timing-safe comparison

The signature check in `decode` (`signed-url.ts:33`) does not compare strings
with `===`. It re-derives the expected signature and uses
`timingSafeEqual`:

```ts
const expected = Buffer.from(sign(payload, domain))
const provided = Buffer.from(signature)
if (
  expected.length !== provided.length ||
  !timingSafeEqual(expected, provided)
) {
  return null
}
```

A length check first because `timingSafeEqual` throws on mismatched lengths
rather than returning `false`; the order is `length !==` then `!timingSafeEqual`
so a short-circuit on length does not leak a comparison-time difference between
"wrong length" and "right length, wrong bytes". A failed verification returns
`null` and the caller treats that as an unauthorized download — no exception,
no partial state, no information about which part was wrong.

---

## 2. `assertReportOmitsValues` — `lib/redaction/report.ts:445`

The export report is a second artifact, delivered alongside the redacted file,
that says what the export did: counts by category and style, what the reviewer
declined, the two checksums that tie the statement to a specific source and
output. It carries **counts and never content** — a report that lists what was
removed verbatim is a leak with a covering letter. `assertReportOmitsValues`
makes that a check rather than a promise: it runs before the report is stored
and throws `ReportLeakError` if any free string in the report contains an
accepted value.

The check has to know which strings in the report are *allowed* to be free
text, which are *allowed* because they come from a fixed vocabulary that cannot
collide with a redacted value, and which it must verify. Four constants draw
those lines.

### `AUTHORED_PATHS` — `report.ts:397`

A set of dotted report paths whose contents this file or the server chose:
identifiers, hashes, a timestamp, a MIME type. These are skipped rather than
matched, because the check is a substring one and prose collides — a
four-letter accepted value like `"port"` occurs inside `"report"`, which
would refuse an export over a coincidence.

```
version, generatedAt, document.id, document.kind, document.sourceChecksum,
artifact.checksum, artifact.mimeType, artifact.extension,
lookedFor.presetId, lookedFor.presetLabel
```

The `notes` array is skipped by a `path.startsWith("notes[")` guard
(`report.ts:465`) for the same reason: notes are English sentences written in
`notesFor` with counts interpolated into them.

### `AUTHORED_PATTERNS` — `report.ts:416`

The attachment list is an array and so has no fixed paths. Each entry is
keyed by MIME part path, and each field is an identifier, a hash, or a
sentence written in `lib/redaction/attachments.ts` — none of them can carry a
filename or a value, which is exactly why the list is keyed by part path. The
pattern matches those fields by index:

```ts
const AUTHORED_PATTERNS = [
  /^attachments\[\d+\]\.(partPath|childDocumentId|artifactChecksum|reason)$/,
]
```

Every other path in an attachment entry — `disposition`, `kind`, `inline` — is
either a closed-vocabulary string or a boolean, and so is checked or skipped
by the vocabulary set below rather than by this pattern.

### `CLOSED_VOCABULARY` — `report.ts:372`

The set of strings the report is allowed to have taken from the document's own
analysis. They are allowed because they come from a fixed vocabulary that
cannot collide with a redacted value:

```ts
const CLOSED_VOCABULARY = new Set<string>([
  ...REDACTION_CATEGORIES,
  ...REDACTION_TYPES,
  ...REDACTION_SOURCES,
  ...REDACTION_STATUSES,
  "removed", "solid", "blur", "pixelate",
  "redacted", "carried-through",
  ...DOCUMENT_KINDS,
])
```

A string leaf that is a member of this set is dropped from the check
(`report.ts:468`). This is also why `safeCategory` (`report.ts:155`) rewrites
an unrecognized category to `"other"` before it reaches a report field — a
category is a free string in the database that a model can return whatever it
likes, and an unrecognized one printed straight into the report would be
unreviewed text from the document's own analysis appearing in the artifact
that is meant to contain none.

### `MIN_VERIFIABLE_LENGTH = 4` — `report.ts:421`

The collision threshold. Strings short enough to collide by accident are not
worth asserting on: an accepted value of `"AI"` would match the `"mail"` in
every MIME type, and `"port"` would match `"report"`. Accepted values shorter
than four characters are dropped from the value list before any comparison
(`report.ts:455`), and the check returns early if that leaves none
(`report.ts:459`).

### `ReportLeakError` — `report.ts:360`

Thrown by `assertReportOmitsValues` when an offending path is found. It carries
the list of offending field paths so a test or log can name them, and its
message is fixed — `"The export report carried document content"` — because
the offending paths are the only thing worth varying and they are on the
instance, not in the message. A later change that adds a field holding a
sample, a snippet or an "example value" fails here rather than shipping a
report that quotes the thing it redacted.

---

## 3. `categoryAllowed` applies to model proposals — `lib/redaction/presets.ts:155`

A preset narrows what the pipeline *looks for*. That is the entire claim, and
it has to hold for both detection passes, not only the deterministic one.

`categoryAllowed(preset, category)` returns `true` if the preset is `null`,
has no `categories` list (`null` means every category), or includes the
category in its list:

```ts
export function categoryAllowed(preset: Preset | null, category: string): boolean {
  if (!preset?.categories) return true
  return preset.categories.includes(category)
}
```

It is called in two places in the analysis pass, not just the deterministic
detectors:

| Call site | What it filters | File:line |
| --- | --- | --- |
| `analyze.ts:207` | The model's per-chunk text detections — a detection whose category the preset turned off is dropped before it is even located in the page. | `lib/ai/analyze.ts:207` |
| `analyze.ts:331` | The model's spreadsheet column classifications — a column the model judges sensitive is dropped if its category is outside the preset. | `lib/ai/analyze.ts:331` |

The comment at `analyze.ts:204` says why this matters: *a preset narrows what
the model may propose as well as what the patterns look for. Asking it to stay
inside the preset is not the same as it having done so.* A preset that turned
off the account-number detector and then accepted the model's account-number
suggestions would be narrowing nothing while looking like it had. Filtering
the model's output by the same `categoryAllowed` gate is what makes "this
preset does not look for X" true rather than aspirational.

`categoryAllowed` is also applied in the workflow orchestrator
(`lib/workflows/process-document.ts:505`, `:534`) so the same rule reaches
detections written by the workflow's own expansion path, and it is the unit
under test in `tests/presets.test.ts:143`.

---

## 4. `PRESET_DISCLAIMER` — `lib/redaction/presets.ts:127`

The one sentence a person must not walk away believing the wrong side of is
that picking a preset did something to their obligations. The disclaimer is a
constant, not copy in a component, so it cannot drift between the places it has
to appear:

> A preset changes what we look for, not what you are responsible for. It is a
> starting point for your review — nothing here certifies a document, and
> anything a preset does not look for stays in the file.

It is shown wherever a preset is chosen or its effect is on display:

| Surface | What is shown | File:line |
| --- | --- | --- |
| **Chooser** (upload panel) | The full `PRESET_DISCLAIMER` sentence under the preset selector, alongside the preset's `looksFor` list. | `components/upload/upload-panel.tsx:486` |
| **Editor** (workspace header) | A reminder of what was searched for — `looked for {presetLabel}` — so "nothing to redact" is not read as a clean document when the search was narrowed. | `components/editor/workspace-header.tsx:113` |
| **Export report** (dialog + report) | The report's `lookedFor` block records `presetId`, `presetLabel`, `categories` and `narrowed` (`report.ts:126`), and a note flags a narrowed search: *"Only one preset's categories were searched for. Anything outside them was never proposed, so its absence from these counts is not evidence it is absent from the file."* (`report.ts:233`). The export dialog surfaces the same idea at `components/redaction/export-dialog.tsx:110`. |

`presetNarrows` (`presets.ts:138`) keeps the warning honest: the default
preset is a preset — the person chose it — but it narrows nothing, and
`presetNarrows` returns `false` for it. A warning that does not apply is how
real ones stop being read, so the narrowed note is only emitted when a preset
actually excluded something.

---

## 5. `AccessError` status codes — `lib/security/access-control.ts:9`

A document id alone never authorizes anything. Every read, mutation and
download goes through `requireDocument`, which re-derives the caller's
identity and compares it with the owner recorded at upload time. The failure
mode is an `AccessError` carrying one of four HTTP status codes:

```ts
export class AccessError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 404 | 410) {
    super(message)
    this.name = "AccessError"
  }
}
```

| Status | Meaning | When it is thrown |
| --- | --- | --- |
| **401** | No session | `requireDocument` is called with no `ownerKey` — the caller has no identity to check against. (`access-control.ts:53`) |
| **404** | Document not found | The id does not exist, **or it exists but belongs to someone else.** A document that exists but is not yours is reported as missing rather than as forbidden, so ownership is not probeable by id. (`access-control.ts:83`) |
| **410** | Document has expired | The document exists and is owned by the caller, but `expiresAt` has passed. Expired documents are gone for a reason — the cleanup sweep has deleted or is about to delete their bytes — and 410 *Gone* says that precisely, rather than letting an expired document be confused with one that was never there. (`access-control.ts:87`) |
| **403** | (Reserved) | Declared on the union but not currently thrown by `requireDocument`. Authorization is binary here — you own a document or you do not — and the "you do not" case is 404 by design. |

The 404-versus-410 split is load-bearing. A response of 404 tells a caller
nothing about whether the id was real; a response of 410 tells the owner that
the document existed and has expired, which is the only useful thing to say
when the bytes are on their way out. The cleanup sweep that produces the
expiry is described in [workflow.md §6](./workflow.md#6-expiry).

---

## 6. Session cookie attributes — `lib/security/fingerprint.ts`

Identity comes from a server-issued random session id in the `anonify_sid`
cookie (`fingerprint.ts:17`). It is minted on first contact by `getIdentity`
and read back on every subsequent request:

```ts
sessionId = randomBytes(24).toString("hex")   // 48 hex chars, ≥ 32 required
cookieStore.set(SESSION_COOKIE, sessionId, {   // writeSession()
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_MAX_AGE,
})
```

| Attribute | Value | Why |
| --- | --- | --- |
| `httpOnly` | `true` | The cookie is never readable by client-side JavaScript. It is an identity token, not something the page needs to inspect, and `httpOnly` keeps it out of any XSS that reaches `document.cookie`. |
| `sameSite` | `"lax"` | The cookie is sent on same-site requests and top-level navigations from other sites, but not on cross-site subrequests (images, `fetch` from another origin). `lax` rather than `strict` so a link from another site still lands authenticated; `strict` would break that for no real gain here, since the cookie carries no privilege beyond owning documents on this instance. |
| `secure` | `true` in production | The cookie only travels over HTTPS in production. In development (`NODE_ENV !== "production"`) it is allowed over plain HTTP so a local clone without TLS still works. |
| `maxAge` | `30 days` (`SESSION_MAX_AGE = 60 * 60 * 24 * 30`, `fingerprint.ts:18`) | The session lasts a month after it was last renewed. Ownership flows through `deriveOwnerKey(sessionId)` (`fingerprint.ts:47`), so a stable session id is what keeps a document reachable; a rolling 30-day window is long enough to come back to a document and short enough that an abandoned browser does not own documents forever. The window rolls on the requests that use what the session owns beyond a document's own lifetime — uploads (`getIdentity`), and creating or editing a global rule, directly or through Hush (`renewIdentity`) — so a global rule, kept for 30 days after its last use, never outlives the cookie that reaches it (see [data-model.md §6a](./data-model.md#6a-ownerrule)). Renewing keeps the same id; it retains nothing server-side, since documents keep their own expiry. |
| `path` | `"/"` | The cookie is scoped to the whole origin, so every route — upload, workspace, download — reads the same identity. |

`peekIdentity` (`fingerprint.ts:109`) is the read-only variant for contexts
that must not mutate cookies (server components, pages). It reads the cookie
without issuing one, returning `null` when there is no session rather than
creating one — because writing a cookie from a page render is a side effect a
GET should not have.

The session id is the only thing the cookie carries. The derived keys —
`ownerKey`, `quotaKey`, `networkKey` — are salted SHA-256 hashes computed
server-side and never sent to the browser, which is why clearing the cookie
resets ownership and quota but does not reset the rate-limit bucket keyed by
network (`deriveNetworkKey`, `fingerprint.ts:57`). See
[architecture.md §3](./architecture.md#3-identity-without-accounts).

---

## 7. Reviewer patterns — `lib/redaction/patterns.ts`

Search and rules run a pattern the reviewer typed against every page of every
document in scope, on the server. A RegEx that backtracks catastrophically,
such as `(a+)+$` against a long line of `a`s, would be a denial of service
with a text box in front of it. The defences, in order:

| Defence | Where | Why |
| --- | --- | --- |
| Linear-time engine | RE2JS (`compileRegex`) | Matching is linear in the text whatever the pattern. Backreferences and lookaround, which need backtracking, do not compile at all. This is the defence; the rest are belt and braces. |
| Length limit | `PATTERN_MAX_LENGTH = 500` | Bounds compile cost and keeps a pattern something a person can review. |
| No empty matches | `compileRegex` | A pattern that can match nothing matches between every pair of characters. |
| Time budget | `RULE_BUDGET_MS = 5000` per document | Measured on the matching alone, so slow storage cannot trip it. |
| Match cap | `RULE_MATCH_LIMIT = 10,000` per document | `\w+` is safe to run and would still redact every word. |

A rule that goes over budget **fails whole**. Every document is planned
before anything is written, and the rule is then written in one transaction.
The same compiler runs in the browser to validate as the reviewer types, so
the browser and the server cannot disagree about what is allowed.

Patterns travel in **request bodies, never query strings**. A search term is
usually the exact value being redacted, and URLs are what access logs, proxies
and browser history keep.

A **global rule** outlives every document, so its pattern is sealed with the
master key (`sealWithMasterKey`) and expires 30 days after it was last used.
See `OwnerRule` in [data-model.md](./data-model.md).

---

## 8. Hush's human in the loop — `lib/assistant/agent.ts`

Hush is an agent with tools that can change the review. It uses the same
provider as analysis, and a document is untrusted input to it. The worst a
hostile paragraph should be able to do is get a bad change *proposed*.

| Defence | Where | Why |
| --- | --- | --- |
| Every change needs approval | `toolApproval` → `user-approval` for each write tool | Nothing a model decides reaches the review without a person pressing Approve on a card that shows what it will do. |
| Approvals are signed | `experimental_toolApprovalSecret`, derived from `FINGERPRINT_SECRET` | The conversation is client-held. Without a signature, a client could send an approval the server never issued. The signature binds tool, call id and input, so an input edited after approval is refused. |
| Reading is asked once | `toolApproval` → `user-approval` for every tool in `READ_TOOLS` until `readConsent` | Anything taken from the document goes to the provider only after the reviewer allows it, and every read is listed. That includes the file name and sheet names, so `get_document_overview` is a read too. |
| The prompt holds nothing from the document before that | `instructions()` in agent.ts, and the panel's request | The instructions go out with the first request, before any card. Until `readConsent` they say "a document" rather than its name, and describe the selection by category, status and page only: not its value, and not its reason, which quotes the value. The panel does not send either until consent. |
| Writes re-validate | `redact_occurrences`, rule tools | A reference must still hold the exact text approved. A rule must compile and fit its budget. The model's input is a proposal, not a fact. |
| Output cannot fetch | `components/assistant/hush-markdown.tsx` | A reply can quote the document. Links render as text, images as alt text, URLs are dropped, and raw HTML is not rendered, so no tracking pixel can phone home by way of a model that repeated it. |
| Tool results are data | the agent's instructions | The model is told that text from tools is document content and never an instruction. The approval step is what makes this safe when it is ignored. |
| Bounded | 12 steps, 80 messages, 1.5 MB counted as it arrives, spend cap, per-visitor `assistantTokens` allowance | A runaway loop costs a bounded amount. The cap and the allowance are checked before every step, not just the first, so a run stops where either runs out. The allowance is what keeps one visitor from spending the whole instance's cap and stopping analysis for everybody else. |

Errors inside the stream are a fixed sentence, never the provider's message,
which can quote the prompt. Only the failure's name is logged.

---

## 9. Sealed uploads — `lib/storage/upload-encryption.ts`, `lib/storage/chunked-web.ts`

Before this, the upload was the one object Anonify stored in the clear. It
stayed that way until ingest re-sealed it, and on Vercel Blob it was a public
object. The browser now seals the file under a single-use upload key before
it leaves the page. [storage.md](./storage.md#sealed-uploads) has the key's
whole life; these are the lines that matter for security:

| Mechanism | Where | Why it is there |
| --- | --- | --- |
| A key of its own | `mintUploadKey` | The document's data key never leaves the server. The upload key protects one transient object that the owner's browser already holds the plaintext of, so returning it discloses nothing new, and a leaked one opens nothing else. |
| Returned once, stored wrapped | `reserveDocument` | The raw key is in the reservation response and nowhere else. The row holds it sealed under the master key, and ingest nulls even that. |
| Non-extractable in the page | `sealFileForUpload` | Imported with `extractable: false`, and the decoded bytes are zeroed when sealing ends. |
| Bound to the reserved path | `openUploadStream` | The AAD's logical key is `uploadKey(id, name)` from the row, never the handle. An upload sealed for another document or path does not open. |
| Chunk size pinned | `ChunkOpener({ chunkShift })` | An upload is sealed by a client. A header declaring the format's largest chunk would otherwise make ingest buffer 32 MiB before the first tag could fail. |
| Recorded, not sniffed | `Document.uploadFormat` | Whether to open the upload is decided by the row. A plaintext file can begin with `ANFY`. |
| Verdict, not weather | `isUnreadableUpload` → `upload-unreadable` | A failed tag or a malformed envelope fails the same way every time, so it is not retried. A storage error on the way through is not one of these, and is retried. |
| Handle must be this document's | `isUploadHandleFor`, `/process`, the token webhook | Ingest reads the handle and then deletes it. An unchecked handle would let a caller aim their document at somebody else's object. |
| Exact length on a presigned PUT | `presignUpload` | `Content-Length` is in the signature, so the bucket takes exactly the number of bytes the server checked against the ceiling. |

`ANONIFY_UPLOAD_ENCRYPTION=required` turns the plaintext path off at
reservation. It is `optional` by default because a page served over plain HTTP
(other than localhost) has no WebCrypto and cannot seal.

## 10. Workflow deliveries — `lib/security/workflow-guard.ts`, `lib/security/workflow-relay.ts`, `proxy.ts`

The workflow runner executes each step by posting it to
`/.well-known/workflow/v1/{flow,step}` on the same server. On Vercel the
platform's queue signs those deliveries. With `@workflow/world-postgres`, the
handlers check nothing: a POST carrying `x-vqs-queue-name`,
`x-vqs-message-id`, `x-vqs-message-attempt` and a well-formed body runs. The
body names a run and a step, whose input the runtime then reads from the
database, so a forged delivery cannot hand a step new input. It can, given a
run's id and a step's, mark that step failed (an attempt count above the
delivery limit does exactly that), or replay a workflow. That was reachable by
anyone who could reach the server's port (#179).

| Mechanism | Where | Why it is there |
| --- | --- | --- |
| A relay on loopback | `startWorkflowRelay` | The runner delivers to `WORKFLOW_LOCAL_BASE_URL`, which `instrumentation.ts` points at a relay on an ephemeral 127.0.0.1 port. Nothing off the machine can reach it. |
| A token per process | `setRelayToken` | 24 random bytes, minted when the relay starts, held on `globalThis` and nowhere else. The relay adds it as `x-anonify-workflow-relay`. |
| Checked before the route | `proxy.ts`, `cameThroughRelay` | A workflow route without the token is a 404, wherever `WORKFLOW_TARGET_WORLD` is set. The comparison does not stop at the first differing character. |
| Not "from localhost" | | A reverse proxy on the same host, or a mesh sidecar, sends outside requests over loopback. The token is the only thing that tells the runner from them. |
| Fails closed | | A process that started no relay (`ANONIFY_ROLE=web`, or a worker that failed to start) has no token, and admits no delivery at all. |

CI posts a well-formed delivery to both routes from outside the container and
expects 404.
