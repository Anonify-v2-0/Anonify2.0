import { getObject, putObject } from "@/lib/storage/blob"
import { decryptDocument, encryptWithDocumentKey } from "@/lib/storage/encryption"
import type { NormalizedDocument } from "@/types/document"

/**
 * The normalized model contains the document's text. It is therefore stored the
 * same way the source is: encrypted under the document's own data key, outside
 * the database.
 */

function key(documentId: string): string {
  return `documents/${documentId}/normalized.json.bin`
}

export async function saveNormalized(
  documentId: string,
  wrappedKey: string,
  model: NormalizedDocument
): Promise<string> {
  const payload = Buffer.from(JSON.stringify(model), "utf8")
  const sealed = encryptWithDocumentKey(payload, wrappedKey)
  const stored = await putObject(key(documentId), sealed)
  return stored.key
}

export async function loadNormalized(
  blobKey: string,
  wrappedKey: string
): Promise<NormalizedDocument> {
  const sealed = await getObject(blobKey)
  const plaintext = decryptDocument(sealed, wrappedKey)
  return JSON.parse(plaintext.toString("utf8")) as NormalizedDocument
}
