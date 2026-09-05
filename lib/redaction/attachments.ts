import { prisma } from "@/lib/database/prisma"
import {
  messageAttachments,
  planAttachment,
} from "@/lib/documents/eml/attachments"
import { decodeEml } from "@/lib/documents/eml/parse"
import type { AttachmentSubstitutions } from "@/lib/redaction/export"
import type { DocumentKind } from "@/types/document"

/**
 * What becomes of each attachment when the message itself is exported.
 *
 * This is the part that is easy to get wrong, and the reason the feature is
 * more than "process the attachments too". Once a redacted child exists, an
 * archive holding a clean PDF *and* an `.eml` that still carries the original
 * PDF is worse than the honest carry-through it replaced: before, the docs
 * told you the enclosure was untouched; after, the archive shows you a
 * redacted enclosure while shipping the unredacted one inside the message.
 * Trusted, and wrong.
 *
 * So every attachment gets one of three answers and the export report names
 * which:
 *
 *   redacted         the child's own verified export is substituted back in
 *   removed          the child is not ready, failed, or was skipped — the
 *                    bytes go, and the removal is reported
 *   carried-through  a format this cannot read at all, left exactly as it
 *                    arrived, now stated per attachment rather than as a
 *                    global caveat in the docs
 *
 * Silently carrying through is the one option that is off the table.
 *
 * The join is recomputed from the message's bytes rather than read from a
 * record written at expansion time. Enumeration is deterministic — the same
 * message yields the same parts in the same order — so recomputing costs a
 * parse and buys the property that a message exported by code that never saw
 * the expansion still reaches the right answer. A supported attachment with no
 * child is one nothing processed, which is a removal, not a pass.
 */

export type AttachmentDisposition = "redacted" | "carried-through" | "removed"

export type AttachmentOutcome = {
  /**
   * The MIME part path, e.g. `0.3`. The path and not the filename: filenames
   * collide, filenames get redacted, and this ends up in a report that is
   * deliberately free of anything the document chose.
   */
  partPath: string
  disposition: AttachmentDisposition
  /** What the bytes turned out to be, when this pipeline could tell. */
  kind: DocumentKind | null
  childDocumentId: string | null
  /** SHA-256 of the redacted enclosure now in the message. */
  artifactChecksum: string | null
  /** True for a part the HTML body references, whose removal a reader sees. */
  inline: boolean
  /** Why, when it is not `redacted`. A sentence written here, never a value. */
  reason: string | null
}

export type ResolvedAttachments = {
  outcomes: AttachmentOutcome[]
  substitutions: AttachmentSubstitutions
}

/** One child's redacted bytes, or null when it has no export to give. */
export type ChildExporter = (
  childDocumentId: string
) => Promise<{ bytes: Uint8Array; checksum: string } | null>

const EMPTY: ResolvedAttachments = { outcomes: [], substitutions: {} }

/** Short, and about the enclosure rather than about what was in it. */
const REASONS: Record<string, string> = {
  quota: "the daily allowance did not stretch to it",
  "extension-mismatch": "its contents did not match the name it was sent under",
  "too-large": "it is larger than this instance will expand into a document",
}

export async function resolveAttachments(input: {
  documentId: string
  kind: DocumentKind
  source: Uint8Array
  exportChild: ChildExporter
}): Promise<ResolvedAttachments> {
  if (input.kind !== "eml") return EMPTY

  const source = decodeEml(input.source)
  const attachments = messageAttachments(source)
  if (attachments.length === 0) return EMPTY

  const children = await prisma.document.findMany({
    where: { parentDocumentId: input.documentId },
    select: { id: true, kind: true, status: true, errorCode: true, sourcePartPath: true },
  })
  const byPath = new Map(
    children.map((child) => [child.sourcePartPath ?? "", child])
  )

  const outcomes: AttachmentOutcome[] = []
  const substitutions: AttachmentSubstitutions = {}

  for (const attachment of attachments) {
    const plan = planAttachment(attachment)
    const child = byPath.get(attachment.path)

    const base = {
      partPath: attachment.path,
      inline: attachment.inline,
      childDocumentId: child?.id ?? null,
      kind: (child?.kind as DocumentKind | undefined) ?? null,
    }

    // Nothing this pipeline reads, and nothing that became a document. Carried
    // through as it always was — but said out loud, per attachment.
    if (!child && plan.action === "carry") {
      outcomes.push({
        ...base,
        kind: null,
        disposition: "carried-through",
        artifactChecksum: null,
        reason: "it is not in a format Anonify can read",
      })
      continue
    }

    const removal = (reason: string): void => {
      substitutions[attachment.path] = {
        action: "remove",
        note: removalNote(reason),
      }
      outcomes.push({
        ...base,
        disposition: "removed",
        artifactChecksum: null,
        reason,
      })
    }

    if (!child) {
      // A supported attachment that nothing expanded. Either this message was
      // processed before attachments became documents, or expansion has not
      // run. Either way there is no redacted version of it, and shipping the
      // original is the one answer that is not available.
      removal("it was never expanded into a document")
      continue
    }

    if (child.status !== "ready") {
      removal(
        REASONS[child.errorCode ?? ""] ??
          (child.status === "failed"
            ? "it could not be processed"
            : "it had not finished processing")
      )
      continue
    }

    const exported = await input.exportChild(child.id)
    if (!exported) {
      removal("its own export could not be produced")
      continue
    }

    substitutions[attachment.path] = {
      action: "replace",
      bytes: exported.bytes,
      checksum: exported.checksum,
    }
    outcomes.push({
      ...base,
      disposition: "redacted",
      artifactChecksum: exported.checksum,
      reason: null,
    })
  }

  return { outcomes, substitutions }
}

/**
 * What replaces a removed attachment's bytes.
 *
 * A part rather than a hole. Deleting the part outright would leave a reader
 * with no sign that anything had been enclosed, and "the archive is missing a
 * file and nobody said so" is the failure this whole feature exists to close.
 */
function removalNote(reason: string): string {
  return [
    "This attachment was removed by Anonify.",
    "",
    `It was not included because ${reason}.`,
    "",
    "The message's own text and metadata were redacted; the accompanying",
    "export report lists what happened to every attachment.",
    "",
  ].join("\r\n")
}
