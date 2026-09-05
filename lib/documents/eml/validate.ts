import PostalMime from "postal-mime"

import { parseHtmlText } from "@/lib/documents/eml/html"
import { decodeEml, decodeTransfer, parseEml } from "@/lib/documents/eml/parse"
import { sha256 } from "@/lib/storage/integrity"

/**
 * Reading an exported message back the way an adversary would.
 *
 * Two parsers, deliberately. Ours knows the tree it built and can enumerate
 * every header, every decoded body and every filename — but a redaction system
 * checking its own work with its own parser is grading its own homework, and
 * the failure it cannot catch is the one that matters: an output only this
 * code can read. So the artifact is also handed to `postal-mime`, a
 * maintained, independent MIME implementation. If it cannot parse the result,
 * the export failed, whatever happened to the sensitive string.
 *
 * Everything both parsers can see is concatenated into one haystack, which the
 * shared verification then searches. Nothing is skipped for being inconvenient:
 * an address hiding in a `Received` line nobody displayed is still an address.
 */

export class EmlVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EmlVerificationError"
  }
}

/** Everything readable in a message, from both parsers, as one string. */
export async function emlHaystack(bytes: Uint8Array): Promise<string> {
  const pieces: string[] = []

  // 1. Our own tree: headers, bodies, filenames, at every depth.
  const { nodes } = parseEml(decodeEml(bytes))

  for (const node of nodes) {
    for (const header of node.headers) pieces.push(header.value)
    if (node.filename) pieces.push(node.filename)
    if (node.text === null) continue

    pieces.push(node.text)
    if (node.contentType === "text/html") {
      // The rendered text as well as the markup: an entity-encoded address is
      // invisible to a search of the source and perfectly visible to a reader.
      pieces.push(parseHtmlText(node.text).text)
    }
  }

  // 2. An independent parser, which is also the check that the output is a
  //    message at all.
  const parsed = await PostalMime.parse(Buffer.from(bytes)).catch(
    (error: unknown) => {
      throw new EmlVerificationError(
        `The exported message could not be reparsed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  )

  pieces.push(parsed.subject ?? "")
  pieces.push(parsed.text ?? "")
  pieces.push(parsed.html ?? "")
  for (const header of parsed.headers) pieces.push(String(header.value ?? ""))
  for (const address of [
    parsed.from,
    ...(parsed.to ?? []),
    ...(parsed.cc ?? []),
    ...(parsed.bcc ?? []),
    ...(parsed.replyTo ?? []),
  ]) {
    if (!address) continue
    pieces.push(address.name ?? "", address.address ?? "")
  }
  for (const attachment of parsed.attachments) {
    pieces.push(attachment.filename ?? "")
  }

  return pieces.join("\n")
}

/**
 * Whether a message still parses, structurally, after being edited.
 *
 * Used by the suites rather than by the export path, which gets the same
 * assurance from `emlHaystack` throwing.
 */
export async function emlReparses(bytes: Uint8Array): Promise<boolean> {
  try {
    parseEml(decodeEml(bytes))
    await PostalMime.parse(Buffer.from(bytes))
    return true
  } catch {
    return false
  }
}

/**
 * What one substituted attachment must be, after the export.
 *
 * A checksum rather than the bytes, because the check is an equality and the
 * bytes are already stored somewhere the caller can point at.
 */
export type AttachmentExpectation = {
  /** Dotted MIME path of the part, e.g. `0.3`. */
  partPath: string
  /** SHA-256 of the child artifact the part is supposed to be carrying. */
  checksum: string
}

export type AttachmentCheck = {
  partPath: string
  passed: boolean
  /** Why it failed, in terms an operator can act on. Never document content. */
  reason: string | null
}

/**
 * Confirms an exported message carries the redacted attachments it claims to.
 *
 * Replacing a part's body is the one rewrite in this pipeline whose content
 * did not come from the message, so it is the one that cannot be verified by
 * searching for what should be absent — a byte-range replacement that landed
 * one part over, or re-encoded wrongly, produces a message that parses, opens
 * and contains none of the accepted values while carrying an attachment that
 * is not the redacted one. The check is therefore an equality: decode the
 * part, hash it, and require the hash the child artifact was stored under.
 *
 * Both parsers again, for the same reason as the haystack. Ours can address
 * the part by path and is the only one that can say *this* part is right.
 * `postal-mime` cannot, so it answers the weaker question that is still worth
 * asking: does an independent reader see an attachment with these bytes at
 * all, or only ours?
 */
export async function verifyAttachmentSubstitutions(
  bytes: Uint8Array,
  expectations: AttachmentExpectation[]
): Promise<AttachmentCheck[]> {
  if (expectations.length === 0) return []

  const source = decodeEml(bytes)
  const { nodes } = parseEml(source)
  const byPath = new Map(nodes.map((node) => [node.path, node]))

  const parsed = await PostalMime.parse(Buffer.from(bytes)).catch(
    (error: unknown) => {
      throw new EmlVerificationError(
        `The exported message could not be reparsed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  )

  const independent = new Set(
    parsed.attachments.map((attachment) =>
      sha256(toBytes(attachment.content, attachment.encoding))
    )
  )

  return expectations.map((expected) => {
    const node = byPath.get(expected.partPath)
    if (!node) {
      return {
        partPath: expected.partPath,
        passed: false,
        reason: "the part is not in the exported message",
      }
    }

    const decoded = decodeTransfer(
      source.slice(node.bodyStart, node.end),
      node.encoding
    )
    if (sha256(new Uint8Array(decoded)) !== expected.checksum) {
      return {
        partPath: expected.partPath,
        passed: false,
        reason: "the part does not decode to the redacted attachment",
      }
    }

    if (!independent.has(expected.checksum)) {
      return {
        partPath: expected.partPath,
        passed: false,
        reason: "an independent parser does not see the redacted attachment",
      }
    }

    return { partPath: expected.partPath, passed: true, reason: null }
  })
}

/** postal-mime hands back whichever shape the part happened to decode to. */
function toBytes(
  content: ArrayBuffer | Uint8Array | string,
  encoding: "base64" | "utf8" | undefined
): Uint8Array {
  if (typeof content === "string") {
    return new Uint8Array(
      Buffer.from(content, encoding === "base64" ? "base64" : "utf8")
    )
  }
  if (content instanceof Uint8Array) return content
  return new Uint8Array(content)
}
