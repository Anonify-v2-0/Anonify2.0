import { createHash } from "node:crypto"
import type { Readable } from "node:stream"

import { FatalError } from "workflow"

import { MAX_UPLOAD_BYTES } from "@/lib/config"
import { prisma } from "@/lib/database/prisma"
import {
  detectDocumentType,
  extensionMatchesKind,
} from "@/lib/documents/detect"
import { DETECTION_SAMPLE_BYTES } from "@/lib/documents/sample"
import {
  deleteObject,
  getObjectStream,
  objectSize,
  sourceKey,
  uploadKey,
} from "@/lib/storage/blob"
import { newDocumentSeal, putSealedStream } from "@/lib/storage/sealed"
import { readHead } from "@/lib/storage/streams"
import {
  isUnreadableUpload,
  openUploadStream,
  sealedUploadPlaintextBytes,
  UNREADABLE_UPLOAD,
  uploadFormatOf,
} from "@/lib/storage/upload-encryption"
import type { DocumentKind } from "@/types/document"

/**
 * Ingest: the upload becomes the document's sealed source.
 *
 * The body of the pipeline's first step, kept out of the workflow file so it
 * can be driven directly: the step in lib/workflows/process-document.ts adds
 * the retry pacing and nothing else. Every refusal here is a `FatalError`,
 * because each is a verdict on the bytes that a second attempt would reach
 * again; anything else is weather, and the step retries it.
 */

export async function runIngest(
  documentId: string
): Promise<{ kind: DocumentKind }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      originalName: true,
      uploadBlobKey: true,
      uploadEncryptionKey: true,
      uploadFormat: true,
      sourceBlobKey: true,
      kind: true,
    },
  })

  if (!document) throw new FatalError("Document no longer exists")

  // Already ingested: the step is replaying after a retry. A run that died
  // between recording the source and deleting the upload left the upload and
  // its key behind, and this is the next chance to finish that.
  if (document.sourceBlobKey) {
    if (document.uploadBlobKey || document.uploadEncryptionKey) {
      await discardUpload(documentId, document.uploadBlobKey)
    }
    return { kind: document.kind as DocumentKind }
  }
  if (!document.uploadBlobKey) {
    throw new FatalError("No upload to ingest")
  }

  const format = uploadFormatOf(document.uploadFormat)
  if (format && !document.uploadEncryptionKey) {
    // Sealed, and the key that opens it is gone. Nothing can read it now.
    throw new FatalError(UNREADABLE_UPLOAD)
  }

  // Refused on the stored size before a byte is read. The count taken while
  // streaming below is the authority; this is the cheap early answer. The
  // ceiling is on the plaintext, which for a sealed upload is its stored size
  // less a header and a tag per chunk.
  const stored = await objectSize(document.uploadBlobKey)
  const declared = format ? sealedUploadPlaintextBytes(stored) : stored
  if (declared === null) throw new FatalError(UNREADABLE_UPLOAD)
  if (declared === 0) throw new FatalError("Uploaded file is empty")
  if (declared > MAX_UPLOAD_BYTES) {
    throw new FatalError("Uploaded file is too large")
  }

  const uploadBlobKey = document.uploadBlobKey
  const wrappedUploadKey = document.uploadEncryptionKey
  const kind = await sealUpload(
    documentId,
    async () => {
      const raw = await getObjectStream(uploadBlobKey)
      if (!format || !wrappedUploadKey) return raw
      return openUploadStream(
        raw,
        wrappedUploadKey,
        // The path it was reserved under, from the row, never from the
        // handle: a Vercel URL carries a suffix, and the binding is to the
        // document, not to wherever the bytes happened to land.
        uploadKey(documentId, document.originalName)
      )
    },
    document.originalName
  )

  await discardUpload(documentId, uploadBlobKey)
  return { kind }
}

/**
 * Deletes the upload and forgets the key it was sealed under. After this the
 * only copy is the source, sealed under the document's own data key.
 */
async function discardUpload(
  documentId: string,
  uploadBlobKey: string | null
): Promise<void> {
  if (uploadBlobKey) await deleteObject(uploadBlobKey)
  await prisma.document.update({
    where: { id: documentId },
    data: { uploadBlobKey: null, uploadEncryptionKey: null },
  })
}

/**
 * Streams the upload through the sniff, the hash and the sealer, and records
 * the sealed copy. `openUpload` yields authenticated plaintext whichever way
 * the upload was stored. The upload itself is left for the caller to delete,
 * once this has let go of it.
 */
async function sealUpload(
  documentId: string,
  openUpload: () => Promise<Readable>,
  originalName: string
): Promise<DocumentKind> {
  const upload = await openUpload()
  try {
    return await sealOpenedUpload(documentId, upload, originalName)
  } catch (error) {
    // A tag that fails, a truncated object, a header that is not ours: the
    // same bytes fail the same way on every attempt, so it is a verdict. A
    // storage error on the way through is not, and goes on to be retried.
    if (!FatalError.is(error) && isUnreadableUpload(error)) {
      throw new FatalError(UNREADABLE_UPLOAD)
    }
    throw error
  } finally {
    upload.destroy()
  }
}

async function sealOpenedUpload(
  documentId: string,
  upload: Readable,
  originalName: string
): Promise<DocumentKind> {
  const { head, rest } = await readHead(upload, DETECTION_SAMPLE_BYTES)

  // The filename is passed as a hint, not as an authority: it can only choose
  // between text formats whose bytes already decode as text.
  const detected = detectDocumentType(head, originalName)
  if (!detected) throw new FatalError("Unsupported file type")
  if (!extensionMatchesKind(originalName, detected.kind)) {
    throw new FatalError("File contents do not match its extension")
  }

  const hash = createHash("sha256")
  let size = 0
  let refusal: FatalError | null = null

  async function* plaintext(): AsyncGenerator<Buffer> {
    size += head.byteLength
    hash.update(head)
    yield head

    for await (const piece of rest) {
      size += piece.byteLength
      if (size > MAX_UPLOAD_BYTES) {
        // The object grew between the size check and the read. Refused as
        // the size check would have refused it, and the half-sealed object
        // is abandoned with the stream rather than stored.
        refusal = new FatalError("Uploaded file is too large")
        throw refusal
      }
      hash.update(piece)
      yield piece
    }
  }

  const seal = newDocumentSeal()
  let stored
  try {
    stored = await putSealedStream(sourceKey(documentId), plaintext(), seal)
  } catch (error) {
    throw refusal ?? error
  }
  if (size === 0) throw new FatalError("Uploaded file is empty")

  await prisma.document.update({
    where: { id: documentId },
    data: {
      sourceBlobKey: stored.key,
      encryptionKey: seal.wrappedKey,
      encryptionFormat: seal.format,
      checksum: hash.digest("hex"),
      size,
      kind: detected.kind,
      mimeType: detected.mimeType,
    },
  })

  return detected.kind
}
