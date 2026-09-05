/**
 * What a message is allowed to cost us.
 *
 * An email is the one format in this product that arrives from strangers by
 * design, and MIME is a recursive container with no natural bound: a message
 * can hold a message that holds a message, a multipart can declare a thousand
 * parts, a header block can be a megabyte of `Received:` lines. None of that
 * needs to be malicious to be a problem — a mailing-list digest with a
 * forwarded thread inside a forwarded thread is ordinary — but all of it is
 * cheap to write and expensive to parse.
 *
 * So the parser is bounded, and it fails closed. Exceeding a limit is a
 * refusal with a reason, never a truncated document presented as a complete
 * one: a reviewer who is shown eight of a message's twelve parts and told
 * nothing has been handed a redaction they cannot trust.
 *
 * The defaults are sized against the upload ceiling rather than guessed. At 50
 * MiB a message could in principle carry a very large number of small parts,
 * so the part count is the binding limit for pathological input, and the
 * decoded-text ceiling is what stops a small compressed body expanding into
 * something the detectors would spend minutes on.
 */

export type EmlLimits = {
  /** How deeply multiparts may nest. */
  maxDepth: number
  /** How many parts one message may contain, counted across the whole tree. */
  maxParts: number
  /** Total decoded text, across every text part and every nested message. */
  maxTextBytes: number
  /** The size of any one part's header block. */
  maxHeaderBytes: number
  /** How many attachments one message may carry. */
  maxAttachments: number
  /** How many `message/rfc822` parts may nest inside one another. */
  maxNestedMessages: number
}

export const DEFAULT_EML_LIMITS: EmlLimits = {
  // A forwarded thread inside a signed multipart inside a digest is roughly
  // six; twenty leaves ample room and still bounds the recursion hard.
  maxDepth: 20,
  // Enough for a digest of a hundred messages with a few parts each. A tree
  // larger than this is not a document somebody is reviewing.
  maxParts: 1_000,
  // Sixteen mebibytes of *text*, after decoding. The upload ceiling bounds the
  // encoded size; this bounds what detection actually has to read, which is
  // the number that costs time.
  maxTextBytes: 16 * 1024 * 1024,
  // One mebibyte of headers. Real messages run to a few kilobytes; a
  // megabyte is already an anomaly and ten is an attack.
  maxHeaderBytes: 1024 * 1024,
  maxAttachments: 200,
  // Five forwards deep. Beyond that the nesting is the point, not the content.
  maxNestedMessages: 5,
}

/** `ANONIFY_EML_MAX_PARTS`, `ANONIFY_EML_MAX_DEPTH`, … */
export function envName(limit: keyof EmlLimits): string {
  return `ANONIFY_EML_${limit
    .replace(/^max/, "MAX_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase()}`
}

/**
 * A malformed override is reported rather than ignored, for the same reason a
 * malformed rate limit is: a limit someone believes they set and which is not
 * in force is worse than no setting at all.
 */
export function emlLimits(): EmlLimits {
  const limits = { ...DEFAULT_EML_LIMITS }

  for (const key of Object.keys(limits) as (keyof EmlLimits)[]) {
    const raw = process.env[envName(key)]?.trim()
    if (!raw) continue

    if (!/^\d+$/.test(raw) || Number(raw) === 0) {
      throw new Error(
        `${envName(key)} must be a positive whole number, got "${raw}"`
      )
    }
    limits[key] = Number(raw)
  }

  return limits
}

/**
 * A limit was exceeded.
 *
 * Separate from a parse failure because it means something different: the
 * message may be perfectly well formed and simply larger than we will look at.
 * The distinction reaches the user as a different sentence.
 */
export class EmlLimitError extends Error {
  constructor(
    readonly limit: keyof EmlLimits,
    readonly allowed: number
  ) {
    super(`Message exceeds the ${limit} limit of ${allowed}`)
    this.name = "EmlLimitError"
  }
}
