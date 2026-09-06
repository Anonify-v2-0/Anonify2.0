import { detectDocumentType } from "@/lib/documents/detect"
import { formatOf } from "@/lib/documents/formats"
import {
  mboxLimits,
  MboxLimitError,
  type MboxLimits,
} from "@/lib/documents/mbox/limits"
import { splitMailbox, type MailboxEntry } from "@/lib/documents/mbox/parse"
import type { DocumentKind } from "@/types/document"

/**
 * A mailbox's messages, as documents.
 *
 * The same relationship attachment expansion established, one level up. A
 * message that carries files becomes a batch because the covering letter and
 * the enclosure are one thing to the person reviewing them; a mailbox becomes
 * a batch for a stronger reason still — the carried decisions are the entire
 * point rather than a convenience. "This recurring name is a colleague, not a
 * subject" answered once and applied to nine hundred messages is work nobody
 * would do by hand, and a name that is a person in one thread and a project
 * codename in another is exactly what a reviewer wants to settle globally and
 * watch propagate.
 *
 * This file decides which bytes become a document and what each one is called.
 * Like the attachment planner it touches neither the database nor the workflow:
 * the enumeration is a pure function of the mailbox and the limits, so running
 * it again produces the same messages in the same order, and a retry cannot
 * disagree with the pass that came before it about which child is which.
 */

/**
 * Why a message did not become a document that could be reviewed.
 *
 * The same vocabulary attachments use, because these are the same refusals an
 * ordinary upload gets. A message costs what the same `.eml` would cost
 * uploaded on its own, and it is refused for the same reasons and told the
 * same sentence.
 */
export type MessageRefusal =
  /** Between two separators, but not a message the pipeline can read. */
  | "unsupported-type"
  /** Larger on its own than the per-message limit allows. */
  | "too-large"
  /**
   * The daily upload allowance did not stretch to it. Never returned here —
   * the allowance is a fact about the caller rather than about the bytes, so
   * it is decided where the charge is made, in lib/documents/expand.ts.
   */
  | "quota"

export type MessagePlan =
  /** Becomes a child document, sealed and processed like any other upload. */
  | {
      action: "expand"
      entry: MailboxEntry
      kind: DocumentKind
      mimeType: string
      name: string
    }
  /**
   * Becomes a child that is present, named and explicitly not processed.
   *
   * Never a silent drop, and here that matters more than anywhere else in the
   * codebase: nobody scrolls a nine-hundred-row batch counting. A message
   * missing with no row for it is a reviewer believing they have seen
   * everything, at the one scale where they cannot check.
   */
  | {
      action: "refuse"
      entry: MailboxEntry
      reason: MessageRefusal
      kind: DocumentKind
      mimeType: string
      name: string
    }

export type MailboxPlan = {
  entries: MessagePlan[]
  /** Bytes across every message that will become a document. */
  expandedBytes: number
}

/**
 * What a message in a mailbox is called.
 *
 * Its position, zero-padded, and nothing else. Deliberately not the subject
 * and deliberately not the `Message-ID`:
 *
 *   - a subject is document content, and a filename ends up in an archive
 *     entry name, in an export report and on a reviewer's disk;
 *   - `Message-ID` is a stranger's input. Real mailboxes carry duplicates
 *     — the same message filed twice, a thread saved from two folders — and
 *     plenty of messages have none at all.
 *
 * The index has neither problem. It is unique, it is stable across a retry
 * that re-splits the mailbox from scratch, and padding it means a directory
 * listing and the batch agree about the order.
 */
export function messageName(index: number, total: number): string {
  const width = Math.max(4, String(total).length)
  return `message-${String(index + 1).padStart(width, "0")}.eml`
}

/**
 * The part path a message is recorded under.
 *
 * The message index rather than a MIME path, because that is what is actually
 * unique and actually stable here. `(parentDocumentId, sourcePartPath)` is
 * unique in the database, so a retry that died halfway through the previous
 * attempt lands on the same path and finds the child it already created rather
 * than making a second one.
 */
export function messagePartPath(index: number): string {
  return `msg-${index}`
}

/**
 * What one message becomes, decided from its bytes.
 *
 * The sniff comes first and settles it, exactly as it does for an attachment
 * and for an upload — never the `From ` line, never a declared content type,
 * both of which a stranger chooses. In practice a message sniffs as `eml`,
 * because the splitter already refused to open a message on bytes that were
 * not a header block; the check is here anyway, because "in practice" is not a
 * property and this is the file that decides what gets processed.
 */
export function planMessage(
  entry: MailboxEntry,
  total: number,
  limits: MboxLimits = mboxLimits()
): MessagePlan {
  const name = messageName(entry.index, total)
  const detected = detectDocumentType(entry.bytes)

  if (!detected || detected.kind !== "eml") {
    return {
      action: "refuse",
      entry,
      reason: "unsupported-type",
      kind: "eml",
      mimeType: formatOf("eml").mimeType,
      name,
    }
  }

  if (entry.bytes.byteLength > limits.maxMessageBytes) {
    return {
      action: "refuse",
      entry,
      reason: "too-large",
      kind: detected.kind,
      mimeType: detected.mimeType,
      name,
    }
  }

  return {
    action: "expand",
    entry,
    kind: detected.kind,
    mimeType: detected.mimeType,
    name,
  }
}

/**
 * Every message of a mailbox, each with its verdict.
 *
 * The depth check is the only thing decided over the whole mailbox here — the
 * count and the total bytes are enforced by `splitMailbox`, which is where
 * they can be answered before anything has been built.
 */
export function planMailbox(
  source: string,
  options: {
    /** How deep this mailbox already sits. Zero for one somebody uploaded. */
    depth?: number
    limits?: MboxLimits
  } = {}
): MailboxPlan {
  const limits = options.limits ?? mboxLimits()
  const depth = options.depth ?? 0

  const found = splitMailbox(source, limits)
  const entries = found.map((entry) => planMessage(entry, found.length, limits))

  const expanding = entries.filter((entry) => entry.action === "expand")

  // Nothing to expand: a mailbox at the depth limit holding only messages we
  // could not read is not one we have to refuse. The limit is about work
  // created, and this creates none.
  if (expanding.length > 0 && depth >= limits.maxDepth) {
    throw new MboxLimitError("maxDepth", limits.maxDepth)
  }

  return {
    entries,
    expandedBytes: expanding.reduce(
      (total, entry) => total + entry.entry.bytes.byteLength,
      0
    ),
  }
}
