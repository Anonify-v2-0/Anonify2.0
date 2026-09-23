import { normalizedKey } from "@/lib/storage/blob"
import {
  getSealed,
  putSealed,
  putSealedStream,
  type DocumentSeal,
} from "@/lib/storage/sealed"
import type { ByteSource } from "@/lib/storage/streams"
import type { NormalizedDocument } from "@/types/document"

/**
 * The normalized model contains the document's text. It is therefore stored the
 * same way the source is: encrypted under the document's own data key, outside
 * the database, and bound to its own path so it cannot be swapped for another
 * of the document's objects.
 */

export async function saveNormalized(
  documentId: string,
  seal: DocumentSeal,
  model: NormalizedDocument
): Promise<string> {
  const payload = Buffer.from(JSON.stringify(model), "utf8")
  const stored = await putSealed(normalizedKey(documentId), payload, seal)
  return stored.key
}

/**
 * Stores a model that arrives as JSON text in pieces, for an extractor that
 * writes pages as it reads them rather than building the whole model first.
 * The pieces must concatenate to one JSON document.
 */
export async function saveNormalizedStream(
  documentId: string,
  seal: DocumentSeal,
  json: ByteSource
): Promise<string> {
  const stored = await putSealedStream(normalizedKey(documentId), json, seal)
  return stored.key
}

export async function loadNormalized(
  documentId: string,
  blobKey: string,
  seal: DocumentSeal
): Promise<NormalizedDocument> {
  const plaintext = await getSealed(blobKey, normalizedKey(documentId), seal)
  return JSON.parse(plaintext.toString("utf8")) as NormalizedDocument
}
