import { MAX_BATCH_FILES } from "@/lib/config"
import { detectDocumentType, extensionMatchesKind } from "@/lib/documents/detect"
import { emlLimits, type EmlLimits } from "@/lib/documents/eml/limits"
import {
  decodeTransfer,
  headerValue,
  parseEml,
  type MimeNode,
} from "@/lib/documents/eml/parse"
import type { DocumentKind } from "@/types/document"

/**
 * The attachments of a message, as documents.
 *
 * A reviewer's mental model is not "the message". It is "this email". Someone
 * who uploads a message with `2026-review-John Smith.pdf` attached, watches the
 * filename get redacted and downloads the result has been handed a covering
 * letter that is clean and an enclosure that is not — the name gone from five
 * places and intact in the sixth, in the one format where documents actually
 * travel.
 *
 * So an attachment is a document, and a message that carries attachments is a
 * batch. This file is the part that decides *which* bytes become a document
 * and what each one costs, and it decides it from the bytes: `detectDocumentType`
 * over the decoded part, never the declared filename and never the declared
 * content type. A stranger chooses both of those.
 *
 * What it deliberately does not do is touch the database or the workflow. The
 * enumeration is a pure function of the message and the limits, which is what
 * makes it safe to run again at export time — the same message yields the same
 * parts in the same order, so a disposition worked out during the export
 * matches the child that expansion created without either having to trust a
 * record written by the other.
 */

// --- limits -----------------------------------------------------------------

/**
 * What expanding a message is allowed to cost us.
 *
 * `emlLimits` bounds *parsing*: how much of a message we will read. Expansion
 * is a different cost with a different amplification factor — every child is a
 * document, with its own run, its own extraction, its own OCR and its own row
 * — so a limit that bounds reading a message says nothing useful about how
 * much work it turns into.
 *
 * Same style as the parser's, on purpose: fail closed, environment
 * overridable, and exceeding one is a refusal with a reason rather than a
 * partial expansion presented as a complete one. A reviewer shown three of a
 * message's seven attachments and told nothing is in exactly the position
 * these limits exist to prevent.
 */
export type ExpansionLimits = {
  /** How many children one message may produce. */
  maxChildren: number
  /** Decoded bytes across every attachment expanded out of one message. */
  maxExpandedBytes: number
  /** The largest single attachment that will be expanded. */
  maxAttachmentBytes: number
  /**
   * How deep expansion may recurse.
   *
   * A `message/rfc822` attached as raw bytes — `application/octet-stream` with
   * a `.eml` name — is sniffed as a message, becomes a child, and expands its
   * own attachments in turn. That is a second recursion axis, orthogonal to
   * the parser's `maxNestedMessages`, which bounds messages the parser walks
   * *inside* one message rather than documents this creates from one. Left
   * unbounded it turns a single 50 MiB upload into an unbounded amount of
   * work.
   */
  maxDepth: number
}

export const DEFAULT_EXPANSION_LIMITS: ExpansionLimits = {
  // The same number a reviewer's own batch is capped at. `maxAttachments` is
  // 200 and bounds what the parser will *read*; this bounds what becomes a
  // document, and a message must not be a way to create a batch five times
  // larger than the upload panel will make.
  maxChildren: MAX_BATCH_FILES,
  // The upload ceiling is 50 MiB and base64 costs a third, so a single message
  // cannot decode to much more than this anyway. Stated rather than inferred,
  // because the ceiling is a deployment setting and this is not.
  maxExpandedBytes: 64 * 1024 * 1024,
  // One attachment is one document, so the ceiling on it is the ceiling on a
  // document. Deliberately not read from MAX_UPLOAD_BYTES: raising what a
  // person may upload is not the same decision as raising what a stranger may
  // cause to be processed.
  maxAttachmentBytes: 25 * 1024 * 1024,
  // The message, its attachments, and one more level. Past that the nesting is
  // the point rather than the content.
  maxDepth: 3,
}

/** `ANONIFY_EML_EXPANSION_MAX_CHILDREN`, `…_MAX_EXPANDED_BYTES`, … */
export function expansionEnvName(limit: keyof ExpansionLimits): string {
  return `ANONIFY_EML_EXPANSION_${limit
    .replace(/^max/, "MAX_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase()}`
}

/**
 * A malformed override is reported rather than ignored, for the same reason
 * the parser's are: a limit somebody believes they set and which is not in
 * force is worse than no setting at all.
 */
export function expansionLimits(): ExpansionLimits {
  const limits = { ...DEFAULT_EXPANSION_LIMITS }

  for (const key of Object.keys(limits) as (keyof ExpansionLimits)[]) {
    const raw = process.env[expansionEnvName(key)]?.trim()
    if (!raw) continue

    if (!/^\d+$/.test(raw) || Number(raw) === 0) {
      throw new Error(
        `${expansionEnvName(key)} must be a positive whole number, got "${raw}"`
      )
    }
    limits[key] = Number(raw)
  }

  return limits
}

/**
 * An expansion limit was exceeded.
 *
 * Separate from `EmlLimitError` because it means something different: the
 * message parsed perfectly well and is simply more work than we will turn into
 * documents.
 */
export class ExpansionLimitError extends Error {
  constructor(
    readonly limit: keyof ExpansionLimits,
    readonly allowed: number
  ) {
    super(`Message exceeds the ${limit} expansion limit of ${allowed}`)
    this.name = "ExpansionLimitError"
  }
}

// --- enumeration ------------------------------------------------------------

/** One attachment part, with the bytes it actually carries. */
export type MessageAttachment = {
  /** Dotted MIME path of the part, e.g. `0.3`. */
  path: string
  /** As declared. A hint for naming only; never used to decide the kind. */
  filename: string | null
  /** As declared. Likewise a hint. */
  contentType: string
  /** `Content-ID`, without the angle brackets, for a part the HTML references. */
  contentId: string | null
  /** True for a part a reader sees as body content rather than as an enclosure. */
  inline: boolean
  /** Decoded bytes: transfer encoding undone. */
  bytes: Uint8Array
}

/** Strips the angle brackets a `Content-ID` is written with. */
function contentIdOf(node: MimeNode): string | null {
  const raw = headerValue(node, "content-id")
  if (!raw) return null
  return raw.trim().replace(/^<|>$/g, "") || null
}

/**
 * Every attachment part of a message, in document order.
 *
 * Deliberately includes inline parts. A `cid:` image is an attachment in the
 * MIME sense and body content to a reader, referenced from the HTML — removing
 * one silently breaks the rendered body, and carrying one through unredacted
 * leaks a photographed ID card that happened to be pasted into an email.
 */
export function messageAttachments(
  source: string,
  limits: EmlLimits = emlLimits()
): MessageAttachment[] {
  const { nodes } = parseEml(source, limits)

  return nodes
    .filter((node) => node.attachment)
    .map((node) => ({
      path: node.path,
      filename: node.filename,
      contentType: node.contentType,
      contentId: contentIdOf(node),
      inline: node.disposition === "inline" || contentIdOf(node) !== null,
      bytes: new Uint8Array(
        decodeTransfer(source.slice(node.bodyStart, node.end), node.encoding)
      ),
    }))
}

// --- classification ---------------------------------------------------------

/**
 * Why an attachment did not become a document that could be redacted.
 *
 * Every one of these is already a failure this pipeline knows how to describe
 * — see lib/workflows/failure.ts — because they are the same refusals an
 * ordinary upload gets. That is the point: an attachment costs what the same
 * file would cost uploaded on its own, and it is refused for the same reasons
 * and told the same sentence.
 */
export type AttachmentRefusal =
  /** Named `.pdf`, but the bytes are a DOCX. Ingest refuses these too. */
  | "extension-mismatch"
  /** Larger on its own than the expansion limit allows. */
  | "too-large"
  /**
   * The daily upload allowance did not stretch to it. Never returned here —
   * the allowance is a fact about the caller rather than about the bytes, so
   * it is decided where the charge is made, in lib/documents/expand.ts.
   */
  | "quota"

export type AttachmentPlan =
  /** Becomes a child document, sealed and processed like any other upload. */
  | {
      action: "expand"
      attachment: MessageAttachment
      kind: DocumentKind
      mimeType: string
      /** What the child is called; derived, never blank. */
      name: string
    }
  /**
   * Becomes a child that is present, named and explicitly not processed.
   *
   * Never a silent drop. An attachment missing from the batch with no row for
   * it is a reviewer believing they have seen everything.
   */
  | {
      action: "refuse"
      attachment: MessageAttachment
      reason: AttachmentRefusal
      /** Known even for a refusal: every refusal happens after the sniff. */
      kind: DocumentKind
      mimeType: string
      name: string
    }
  /**
   * Carried through as it is, which is what happened to every attachment
   * before this existed. Still stated per attachment in the export report
   * rather than as a global caveat in the docs.
   */
  | { action: "carry"; attachment: MessageAttachment }

/**
 * What one attachment becomes, decided from its bytes.
 *
 * The sniff comes first and settles everything else. A part it cannot read is
 * carried through — a zero-byte part and a `.zip` take the same road, and both
 * are right for the same reason: there is nothing here this pipeline could
 * redact, and removing it would be a surprise rather than a redaction.
 *
 * The extension check runs last, because "named `.pdf`, actually a DOCX" is
 * only interesting once we know it is a document at all.
 */
export function planAttachment(
  attachment: MessageAttachment,
  limits: ExpansionLimits = expansionLimits()
): AttachmentPlan {
  const name = attachmentName(attachment)
  const detected = detectDocumentType(
    attachment.bytes,
    attachment.filename ?? undefined
  )

  if (!detected) return { action: "carry", attachment }

  const refusal = (reason: AttachmentRefusal): AttachmentPlan => ({
    action: "refuse",
    attachment,
    reason,
    kind: detected.kind,
    mimeType: detected.mimeType,
    name: named(name, detected.extension),
  })

  if (attachment.bytes.byteLength > limits.maxAttachmentBytes) {
    return refusal("too-large")
  }

  // Refused as a named, skipped child rather than as a failure of the whole
  // message: a stranger picked the filename, and one lie in it must not cost
  // the reviewer the other six attachments.
  if (
    attachment.filename &&
    !extensionMatchesKind(attachment.filename, detected.kind)
  ) {
    return refusal("extension-mismatch")
  }

  return {
    action: "expand",
    attachment,
    kind: detected.kind,
    mimeType: detected.mimeType,
    name: named(name, detected.extension),
  }
}

/**
 * A name for the child.
 *
 * Filenames in a message are a stranger's input: they collide, they are empty,
 * they are RFC 2231 continuations, they are `../../etc/passwd`. Only the last
 * of those is a hazard here and it is not this function's to fix — zip entry
 * names are sanitized where they are written, in lib/redaction/archive.ts —
 * so this only has to guarantee a name exists. The part path is the fallback
 * because it is the thing that is actually unique.
 */
export function attachmentName(attachment: MessageAttachment): string {
  const declared = attachment.filename?.trim()
  if (declared) return declared
  // Dots become underscores so the fallback does not end in something that
  // reads as an extension: `part-0.2` would be taken as a file of type "2",
  // and the kind would then never make it onto the name.
  return `part-${attachment.path.replace(/\./g, "_")}`
}

/** Gives a name an extension when it has none, so the kind survives a download. */
function named(name: string, extension: string): string {
  return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${extension}`
}

// --- the plan for a whole message -------------------------------------------

export type ExpansionPlan = {
  entries: AttachmentPlan[]
  /** Decoded bytes across every attachment that will become a document. */
  expandedBytes: number
}

/**
 * Every attachment of a message, each with its verdict, or a refusal.
 *
 * The whole-message limits are checked over the finished list rather than
 * while walking it, because a partial expansion is the one outcome that is not
 * on the table: stopping at the tenth attachment of twelve produces a batch
 * that looks complete and is not.
 */
export function planExpansion(
  source: string,
  options: {
    /** How deep this message already sits. Zero for one somebody uploaded. */
    depth?: number
    limits?: ExpansionLimits
    parserLimits?: EmlLimits
  } = {}
): ExpansionPlan {
  const limits = options.limits ?? expansionLimits()
  const depth = options.depth ?? 0

  const entries = messageAttachments(source, options.parserLimits).map(
    (attachment) => planAttachment(attachment, limits)
  )

  const expanding = entries.filter((entry) => entry.action === "expand")

  // Nothing to expand: a message at the depth limit carrying only a zip is not
  // a message we have to refuse. The limit is about work created, and this
  // creates none.
  if (expanding.length > 0 && depth >= limits.maxDepth) {
    throw new ExpansionLimitError("maxDepth", limits.maxDepth)
  }

  // Children, not expansions: a refused attachment is a row somebody has to
  // read, and a message with a thousand of them is the same denial of service
  // by a different door.
  const children = entries.filter((entry) => entry.action !== "carry").length
  if (children > limits.maxChildren) {
    throw new ExpansionLimitError("maxChildren", limits.maxChildren)
  }

  const expandedBytes = expanding.reduce(
    (total, entry) => total + entry.attachment.bytes.byteLength,
    0
  )
  if (expandedBytes > limits.maxExpandedBytes) {
    throw new ExpansionLimitError("maxExpandedBytes", limits.maxExpandedBytes)
  }

  return { entries, expandedBytes }
}
