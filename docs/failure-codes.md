# Failure codes

`lib/workflows/failure.ts`

The pipeline used to store `error.message` verbatim and render it, so the screen
said `FatalError: Unsupported file type` — the workflow SDK's class name, in
front of a sentence the user then had to interpret. Worse, *every* error took
that path: a Prisma failure, a storage timeout or a malformed provider response
each put its own internal message on a stranger's screen.

This module is the fix. Two rules hold:

1. **The message a user sees always comes from the table below**, never from the
   thrown error. The raw text is read only to pick a code and is then discarded.
   That matters beyond tidiness: a parser or driver error is not guaranteed to
   be free of document content, and invariant 6 says nothing logs or stores it.
2. **`retryable` answers one question**: could running the same pipeline again,
   right now, produce a different result? An unsupported file type does not
   become supported on the second attempt, and offering a button that cannot
   work is worse than offering none.

The module imports nothing, so the client can classify a stored code without
pulling the server in behind it.

---

## The 14 codes

Every code carries a short message written for a person and a `retryable`
flag. The message is fixed per code — it is never derived from the thrown
error's text.

| Code | Meaning | Retryable |
| --- | --- | --- |
| `unsupported-type` | The file is not in a format Anonify can read. The supported set is generated from the format register, so adding a format cannot leave the refusal naming the old list. | No |
| `extension-mismatch` | The file's contents do not match its extension — a `.pdf` that is actually a zip. It was not processed; the user is asked to check the file really is what its name says. | No |
| `empty-file` | The uploaded file has zero bytes, so there was nothing to analyze. | No |
| `too-large` | The file is larger than this instance's upload limit (`MAX_UPLOAD_BYTES`). | No |
| `corrupt-source` | The stored copy of the file no longer matches the checksum taken when it was uploaded, so it was not read. The user is asked to upload it again. | No |
| `missing-upload` | The uploaded file is no longer available — the blob was removed before ingest, or the document row is gone. | No |
| `too-complex` | The file is more than this instance will read or expand: too many messages or parts, too deeply nested, or too much content behind them. Refused whole, because a partly processed file would look complete and would not be. An administrator can raise the limits; see `.env.example`. | No |
| `empty-container` | A mailbox with no messages that could be read out of it. Distinct from `empty-file`, which has no bytes at all: this one has bytes and nothing in them, and telling somebody their 30 MiB archive is empty would send them looking for the wrong problem. | No |
| `quota` | The document needs more of today's allowance than is left. The allowance resets at midnight UTC. Not retryable, even though the allowance does eventually reset: a retry pressed before it does spends a rate-limit token to fail in the same way, which is the whole complaint. | No |
| `internal-state` | Processing stopped partway through and cannot resume from where it stopped. Also the fallback for an unrecognised `FatalError` the pipeline threw itself — the pipeline only throws one where it has decided retrying is pointless. | No |
| `configuration` | The instance is not fully configured, so processing could not run. This needs an administrator rather than a retry — a retry loop against a missing environment variable is a shape of failure this codebase has already been bitten by once. | No |
| `storage` | The file store could not be reached while processing this document. That is usually temporary. | Yes |
| `database` | The database could not be reached while processing this document. That is usually temporary. | Yes |
| `timeout` | Analyzing this document took longer than allowed and was stopped. That is usually temporary. | Yes |
| `unknown` | Something went wrong while analyzing this document. The original file was not modified. The catch-all for anything the matchers do not recognise. | Yes |

---

## Classification

### `MATCHERS` — first match wins

`describeFailure` does not read the thrown error's class or stack. It reads the
message text and walks a list of regexes, returning the code of the first one
that matches:

```ts
const MATCHERS: { code: FailureCode; pattern: RegExp }[] = [
  { code: "extension-mismatch", pattern: /contents do not match its extension/i },
  { code: "unsupported-type",   pattern: /unsupported file type|no extractor registered/i },
  { code: "empty-file",        pattern: /file is empty/i },
  { code: "too-large",         pattern: /file is too large/i },
  { code: "corrupt-source",    pattern: /checksum mismatch/i },
  { code: "too-complex",       pattern: /exceeds the \w+ (expansion )?limit of/i },
  { code: "empty-container",   pattern: /no messages found in this mailbox/i },
  { code: "missing-upload",    pattern: /no upload to ingest|document no longer exists/i },
  { code: "quota",             pattern: /daily demo limit reached/i },
  { code: "internal-state",    pattern: /has not been (ingested|normalized)/i },
  { code: "configuration",      pattern: /environment variable|must decode to|is not configured/i },
  { code: "database",          pattern: /database_url|econnrefused|prisma|connection (pool|terminated)/i },
  { code: "storage",           pattern: /\bblob\b|\bs3\b|fetch failed|enoent|no such file/i },
  { code: "timeout",           pattern: /timeout|etimedout|timed out|\baborted\b/i },
]
```

**Ordering is load-bearing.** The pipeline's own `FatalError` messages are
listed before the broad infrastructure patterns — "no such file" should be read
as storage only once we know it is not one of the specific cases above it. The
matchers are tried top to bottom and the first hit wins; anything that matches
none of them falls through to `unknown`.

`too-complex` is worded to cover the MIME parser's limits, attachment
expansion's and the mailbox's, deliberately: to the person holding the file
they are one refusal with one remedy.

### `unwrap` — fatal vs retried

The error that crosses the durable boundary is not the instance that was
thrown — the class name arrives folded into the message — so `FatalError.is()`
cannot be relied on alone, and the wrappers nest:

```
FatalError: Step "…//extractAndNormalize" failed after 3 retries: <cause>
```

`unwrap` peels those wrappers in a bounded loop (depth 4, so a wrapper that
peels to itself cannot spin) and returns three things:

- **`message`** — the cause underneath the wrappers, which `classify` then
  reads.
- **`fatal`** — true only when a `FatalError` class prefix was seen *and* no
  "failed after N retries" wrapper was. A `FatalError` the pipeline threw
  itself skips retrying, so it never carries the step wrapper; that difference
  is what tells the two apart.
- **`retried`** — true when a "failed after N retries" wrapper was seen. A
  step that exhausted its retries is re-thrown as a `FatalError` too, because
  from the runtime's side there is nothing left to try — but the cause
  underneath was transient enough to be retried, and reporting it as a verdict
  would take the retry button away in exactly the case that wants it.

That shape is why `fatal` is not simply "the message said `FatalError`".

### `describeFailure`

```ts
export function describeFailure(error: unknown): DocumentFailure
```

The entry point the `fail` step calls. It unwraps, classifies, and applies one
extra rule: **an unrecognised `FatalError` is still fatal.** The pipeline only
throws one where it has decided retrying is pointless, and honouring that
matters more than the generic default, which assumes the opposite. An
unrecognised fatal error therefore maps to `internal-state` rather than
`unknown`. (`unwrap` has already ruled out the retry-exhausted case, which
wears the same class name without meaning the same thing.)

### `failureForCode`

```ts
export function failureForCode(code: string | null | undefined): DocumentFailure
```

The reverse direction: look up the message and retryability for a code already
stored on a document. An unknown or missing code resolves to `unknown`.

### `isRetryable`

```ts
export function isRetryable(code: string | null | undefined): boolean
```

Whether offering a retry is worth it. A document that failed before the code
column existed has no code at all; those stay retryable, because the old
behaviour is what the user already expects and a retry is cheap. Anything with
a code returns that code's `retryable` flag from the table above.

---

## See also

- [workflow.md](./workflow.md) §7 — failure from the user's side, and the
  invariant that the source is never mutated.
