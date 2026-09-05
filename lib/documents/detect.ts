import { formatOf, kindForExtension } from "@/lib/documents/formats"
import { looksLikeEml } from "@/lib/documents/eml/parse"
import { looksLikeRtf } from "@/lib/documents/rtf/parse"
import type { DocumentKind } from "@/types/document"

/**
 * Content sniffing. The browser-supplied MIME type and the filename are hints;
 * the bytes decide. A file whose contents disagree with its extension is
 * rejected rather than guessed at.
 *
 * Most formats announce themselves in their first few bytes. Text formats do
 * not — a CSV, a TSV and a plain text file are all just characters — so for
 * those the bytes settle the question that actually matters (*is this text at
 * all, and is it text we can decode?*) and the extension picks between the
 * text formats. That is a hint doing the job hints are good for: it can only
 * choose among formats the content already qualifies for, and it cannot make
 * an executable, an archive or a binary blob into a document.
 */

export type DetectedType = {
  kind: DocumentKind
  mimeType: string
  extension: string
}

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

/** Zip entry names sit uncompressed in local file headers, so a scan is enough. */
function zipContains(bytes: Uint8Array, needle: string): boolean {
  const haystack = Buffer.from(
    bytes.subarray(0, Math.min(bytes.length, 64 * 1024))
  ).toString("latin1")
  return haystack.includes(needle)
}

/** How much of a file is read to decide whether it is text. */
const TEXT_SAMPLE_BYTES = 64 * 1024

/** Control characters no text document contains. Tab, CR and LF are fine. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/

/**
 * Whether the bytes decode as UTF-8 text.
 *
 * A prefix is decoded rather than the whole file, so a large CSV is not
 * decoded twice — but a prefix can end mid-character, which a fatal decoder
 * would reject, so the sample is taken with a streaming decoder that tolerates
 * a truncated tail.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, TEXT_SAMPLE_BYTES)

  let text: string
  try {
    // `stream: true` holds back an incomplete trailing sequence instead of
    // treating it as invalid, which is exactly the truncation case.
    text = new TextDecoder("utf-8", { fatal: true }).decode(sample, {
      stream: true,
    })
  } catch {
    return false
  }

  return !CONTROL_CHARACTERS.test(text)
}

/** The text formats, in the order a bare extension is resolved against. */
const TEXT_KINDS: DocumentKind[] = ["csv", "tsv", "txt"]

function textKindFor(filename: string | undefined): DocumentKind | null {
  if (!filename) return null
  const kind = kindForExtension(extensionOf(filename))
  return kind && TEXT_KINDS.includes(kind) ? kind : null
}

export function detectDocumentType(
  bytes: Uint8Array,
  filename?: string
): DetectedType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { kind: "pdf", mimeType: "application/pdf", extension: "pdf" }
  }

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", mimeType: "image/png", extension: "png" }
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: "image", mimeType: "image/jpeg", extension: "jpg" }
  }

  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { kind: "image", mimeType: "image/webp", extension: "webp" }
  }

  if (startsWith(bytes, ZIP_SIGNATURE)) {
    // A zip is only one of these if it carries the part tree that format is
    // made of. An arbitrary archive renamed to .docx is still an archive.
    if (zipContains(bytes, "word/")) {
      return {
        kind: "docx",
        mimeType: formatOf("docx").mimeType,
        extension: "docx",
      }
    }
    if (zipContains(bytes, "xl/")) {
      return {
        kind: "xlsx",
        mimeType: formatOf("xlsx").mimeType,
        extension: "xlsx",
      }
    }
    if (zipContains(bytes, "ppt/")) {
      return {
        kind: "pptx",
        mimeType: formatOf("pptx").mimeType,
        extension: "pptx",
      }
    }
    return null
  }

  // RTF announces itself, which is why it is settled here rather than by the
  // extension: a file that opens `{\rtf` is RTF whatever it is called.
  if (looksLikeRtf(bytes)) {
    return {
      kind: "rtf",
      mimeType: formatOf("rtf").mimeType,
      extension: "rtf",
    }
  }

  // A message has a structure that can be checked without the filename:
  // header lines, at least one of which is a header a message actually has.
  // Deliberately not gated on the text test below — a message may carry an
  // attachment transferred as raw 8-bit binary, which is a valid message and
  // not a text file.
  if (looksLikeEml(bytes)) {
    return {
      kind: "eml",
      mimeType: formatOf("eml").mimeType,
      extension: "eml",
    }
  }

  // Text last, because it is the only test that is about the absence of
  // something rather than the presence of it.
  const textKind = textKindFor(filename)
  if (textKind && looksLikeText(bytes)) {
    const format = formatOf(textKind)
    return {
      kind: textKind,
      mimeType: format.mimeType,
      extension: extensionOf(filename ?? "") || format.extension,
    }
  }

  return null
}

export function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim())
  return match ? match[1].toLowerCase() : ""
}

/** True when the filename's extension is consistent with the sniffed bytes. */
export function extensionMatchesKind(
  filename: string,
  kind: DocumentKind
): boolean {
  const extension = extensionOf(filename)
  if (!extension) return true
  const expected = kindForExtension(extension)
  return expected === undefined || expected === kind
}
