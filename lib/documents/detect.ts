import type { DocumentKind } from "@/types/document"

/**
 * Content sniffing. The browser-supplied MIME type and the filename are hints;
 * the bytes decide. A file whose contents disagree with its extension is
 * rejected rather than guessed at.
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

export function detectDocumentType(bytes: Uint8Array): DetectedType | null {
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
    if (zipContains(bytes, "word/")) {
      return {
        kind: "docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        extension: "docx",
      }
    }
    if (zipContains(bytes, "xl/")) {
      return {
        kind: "xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: "xlsx",
      }
    }
  }

  return null
}

export function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim())
  return match ? match[1].toLowerCase() : ""
}

const EXTENSION_KINDS: Record<string, DocumentKind> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
}

/** True when the filename's extension is consistent with the sniffed bytes. */
export function extensionMatchesKind(
  filename: string,
  kind: DocumentKind
): boolean {
  const extension = extensionOf(filename)
  if (!extension) return true
  const expected = EXTENSION_KINDS[extension]
  return expected === undefined || expected === kind
}
