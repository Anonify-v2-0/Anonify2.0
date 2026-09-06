import { supportedFormatsSentence } from "@/lib/documents/formats"

/**
 * Turning a thrown error into something a person can act on.
 *
 * The pipeline used to store `error.message` verbatim and render it, so the
 * screen said `FatalError: Unsupported file type` — the workflow SDK's class
 * name, in front of a sentence the user then had to interpret. Worse, *every*
 * error took that path: a Prisma failure, a storage timeout or a malformed
 * provider response each put its own internal message on a stranger's screen.
 *
 * The API layer already refuses to do this — `handleRouteError` categorises and
 * generalises precisely so internal detail never reaches a client — and the
 * workflow was the one path that bypassed it. This is the equivalent for
 * processing failures.
 *
 * Two rules hold here:
 *
 * 1. **The message a user sees always comes from the table below**, never from
 *    the thrown error. The raw text is read only to pick a code and is then
 *    discarded. That matters beyond tidiness: a parser or driver error is not
 *    guaranteed to be free of document content, and invariant 6 says nothing
 *    logs or stores it.
 * 2. **`retryable` answers one question**: could running the same pipeline
 *    again, right now, produce a different result? An unsupported file type
 *    does not become supported on the second attempt, and offering a button
 *    that cannot work is worse than offering none.
 *
 * This module imports nothing, so the client can classify a stored code without
 * pulling the server in behind it.
 */

export const FAILURE_CODES = [
  "unsupported-type",
  "extension-mismatch",
  "empty-file",
  "too-large",
  "corrupt-source",
  "missing-upload",
  "too-complex",
  "empty-container",
  "quota",
  "internal-state",
  "configuration",
  "storage",
  "database",
  "timeout",
  "unknown",
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

export type DocumentFailure = {
  code: FailureCode
  /** Written for a person. Never derived from the thrown error's text. */
  message: string
  /** False when running the pipeline again cannot produce a different result. */
  retryable: boolean
}

const FAILURES: Record<FailureCode, Omit<DocumentFailure, "code">> = {
  "unsupported-type": {
    // Generated from the register rather than written out, so adding a format
    // cannot leave the refusal message naming the old list.
    message:
      "This file is not in a format Anonify can read. It supports " +
      `${supportedFormatsSentence()}.`,
    retryable: false,
  },
  "extension-mismatch": {
    message:
      "This file's contents do not match its extension, so it was not processed. Check that the file is really what its name says it is.",
    retryable: false,
  },
  "empty-file": {
    message: "This file is empty, so there was nothing to analyze.",
    retryable: false,
  },
  "too-large": {
    message: "This file is larger than this instance's upload limit.",
    retryable: false,
  },
  "corrupt-source": {
    message:
      "The stored copy of this file no longer matches the checksum taken when it was uploaded, so it was not read. Upload it again.",
    retryable: false,
  },
  "missing-upload": {
    message: "The uploaded file is no longer available. Upload it again.",
    retryable: false,
  },
  // Fail closed, with a reason. The alternative is a partial result presented
  // as a complete one — a reviewer shown three of a message's seven
  // attachments and told nothing is in exactly the position the limits exist
  // to prevent. An administrator can raise the limits; see .env.example.
  "too-complex": {
    message:
      "This file is more than this instance will read or expand: too many messages or parts, too deeply nested, or too much content behind them. It was not processed at all, because a partly processed file would look complete and would not be.",
    retryable: false,
  },
  // A container whose contents could not be found at all. Distinct from an
  // empty file, which has no bytes: this one has bytes and no messages in
  // them, and telling somebody their 30 MiB mailbox is empty would send them
  // looking for the wrong problem.
  "empty-container": {
    message:
      "No messages could be read out of this mailbox, so there was nothing to expand. Check that it is a mailbox export rather than a single message saved with an .mbox name.",
    retryable: false,
  },
  // Not retryable, even though the allowance does eventually reset: a retry
  // pressed before it does spends a rate-limit token to fail in the same way,
  // which is the whole complaint. The message says what actually helps instead.
  quota: {
    message:
      "This document needs more of today's allowance than is left. The allowance resets at midnight UTC — upload it again after that.",
    retryable: false,
  },
  "internal-state": {
    message:
      "Processing stopped partway through and cannot resume from where it stopped. Upload the document again.",
    retryable: false,
  },
  // An administrator has to change something. A retry loop against a missing
  // environment variable is the shape of failure this codebase has already been
  // bitten by once — see the ENCRYPTION_KEY placeholder that YAML turned into 0.
  configuration: {
    message:
      "This instance is not fully configured, so processing could not run. This needs an administrator rather than a retry.",
    retryable: false,
  },
  storage: {
    message:
      "The file store could not be reached while processing this document. That is usually temporary.",
    retryable: true,
  },
  database: {
    message:
      "The database could not be reached while processing this document. That is usually temporary.",
    retryable: true,
  },
  timeout: {
    message:
      "Analyzing this document took longer than allowed and was stopped. That is usually temporary.",
    retryable: true,
  },
  unknown: {
    message:
      "Something went wrong while analyzing this document. Your original file was not modified.",
    retryable: true,
  },
}

/**
 * First match wins, so the pipeline's own `FatalError` messages are listed
 * before the broad infrastructure patterns — "no such file" should be read as
 * storage only once we know it is not one of the specific cases above it.
 */
const MATCHERS: { code: FailureCode; pattern: RegExp }[] = [
  { code: "extension-mismatch", pattern: /contents do not match its extension/i },
  { code: "unsupported-type", pattern: /unsupported file type|no extractor registered/i },
  { code: "empty-file", pattern: /file is empty/i },
  { code: "too-large", pattern: /file is too large/i },
  { code: "corrupt-source", pattern: /checksum mismatch/i },
  // Both the parser's limits and expansion's, which are worded alike on
  // purpose: to the person holding the message they are one refusal.
  { code: "too-complex", pattern: /exceeds the \w+ (expansion )?limit of/i },
  { code: "empty-container", pattern: /no messages found in this mailbox/i },
  { code: "missing-upload", pattern: /no upload to ingest|document no longer exists/i },
  { code: "quota", pattern: /daily demo limit reached/i },
  { code: "internal-state", pattern: /has not been (ingested|normalized)/i },
  {
    code: "configuration",
    pattern: /environment variable|must decode to|is not configured/i,
  },
  {
    code: "database",
    pattern: /database_url|econnrefused|prisma|connection (pool|terminated)/i,
  },
  { code: "storage", pattern: /\bblob\b|\bs3\b|fetch failed|enoent|no such file/i },
  { code: "timeout", pattern: /timeout|etimedout|timed out|\baborted\b/i },
]

/**
 * Peels the wrappers the runtime adds before an error reaches the orchestrator.
 *
 * The reconstructed error crossing the durable boundary is not the instance
 * that was thrown — the class name arrives folded into the message — so
 * `FatalError.is()` cannot be relied on alone, and these wrappers nest:
 *
 *     FatalError: Step "…//extractAndNormalize" failed after 3 retries: <cause>
 *
 * That shape is why `fatal` is not simply "the message said FatalError". A step
 * that exhausts its retries is re-thrown as a `FatalError` too, because from the
 * runtime's side there is nothing left to try — but the cause underneath was
 * transient enough to be retried three times, and reporting it as a verdict
 * would take the retry button away in exactly the case that wants it. A
 * `FatalError` the pipeline threw itself skips retrying, so it never carries the
 * step wrapper; that difference is what tells the two apart.
 */
function unwrap(raw: string): {
  message: string
  fatal: boolean
  retried: boolean
} {
  let message = raw.trim()
  let named = false
  let retried = false

  // Bounded rather than `while (true)`: this runs over text that arrived from
  // somewhere else, and a wrapper that peels to itself must not spin.
  for (let depth = 0; depth < 4; depth += 1) {
    const exhausted =
      /^Step\s+"[^"]*"\s+failed after \d+ retr(?:y|ies):\s*([\s\S]*)$/i.exec(message)
    if (exhausted) {
      retried = true
      message = exhausted[1].trim()
      continue
    }

    const classPrefix = /^([A-Za-z][A-Za-z0-9]*Error):\s*([\s\S]*)$/.exec(message)
    if (classPrefix) {
      if (classPrefix[1] === "FatalError") named = true
      message = classPrefix[2].trim()
      continue
    }

    break
  }

  return { message, fatal: named && !retried, retried }
}

function classify(message: string): FailureCode {
  for (const { code, pattern } of MATCHERS) {
    if (pattern.test(message)) return code
  }
  return "unknown"
}

/** The user-facing failure for a thrown error. */
export function describeFailure(error: unknown): DocumentFailure {
  const raw = error instanceof Error ? error.message : String(error)
  const { message, fatal } = unwrap(raw)
  const code = classify(message)

  // A FatalError the table does not recognise is still fatal: the pipeline only
  // throws one where it has decided retrying is pointless, and honouring that
  // matters more than the generic default, which assumes the opposite. Note
  // that `unwrap` has already ruled out the retry-exhausted case, which wears
  // the same class name without meaning the same thing.
  if (code === "unknown" && fatal) {
    return { code: "internal-state", ...FAILURES["internal-state"] }
  }

  return { code, ...FAILURES[code] }
}

/** The failure for a code already stored on a document. */
export function failureForCode(code: string | null | undefined): DocumentFailure {
  const known = (FAILURE_CODES as readonly string[]).includes(code ?? "")
    ? (code as FailureCode)
    : "unknown"
  return { code: known, ...FAILURES[known] }
}

/**
 * Whether retrying is worth offering.
 *
 * A document that failed before the code column existed has no code at all;
 * those stay retryable, because the old behaviour is what the user already
 * expects and a retry is cheap.
 */
export function isRetryable(code: string | null | undefined): boolean {
  if (!code) return true
  return failureForCode(code).retryable
}
