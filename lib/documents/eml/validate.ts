import PostalMime from "postal-mime"

import { parseHtmlText } from "@/lib/documents/eml/html"
import { decodeEml, parseEml } from "@/lib/documents/eml/parse"

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
