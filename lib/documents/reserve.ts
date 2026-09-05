import { prisma } from "@/lib/database/prisma"
import { extensionOf } from "@/lib/documents/detect"
import { newDocumentId } from "@/lib/documents/ids"
import { checkQuota, quotaMessage, recordUsage } from "@/lib/security/usage"
import { uploadKey } from "@/lib/storage/blob"

/**
 * Staking the claim before the browser uploads.
 *
 * The client uploads directly to storage, so the server has to decide first:
 * what the file is, whether the caller's allowance covers it, and which path
 * the upload token will later agree to sign.
 *
 * One document and a batch of them take the same path through here, which is
 * the point of it being a function rather than route code — a batch that
 * charged quota differently, or accepted a file type the single upload refuses,
 * would be a second definition of what an upload is.
 */

const EXTENSION_KINDS: Record<string, string> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
}

export type ReservedDocument = {
  id: string
  pathname: string
  expiresAt: Date
  quota: { used: number; limit: number }
}

export type ReserveRefusal = {
  reason: "unsupported-type" | "quota"
  status: 415 | 429
  message: string
  quota?: { used: number; limit: number }
}

export type ReserveResult =
  | ({ ok: true } & ReservedDocument)
  | ({ ok: false } & ReserveRefusal)

export async function reserveDocument(input: {
  filename: string
  size: number
  contentType?: string
  ttlSeconds: number
  ownerKey: string
  quotaKey: string
  batchId?: string
  /** Named detector set; absent means everything is looked for. */
  preset?: string
}): Promise<ReserveResult> {
  const kind = EXTENSION_KINDS[extensionOf(input.filename)]
  if (!kind) {
    return {
      ok: false,
      reason: "unsupported-type",
      status: 415,
      message: "Unsupported file type",
    }
  }

  // The browser's `file.type` is a guess, not a fact, and it is wrong often
  // enough to matter: Windows reports application/x-zip-compressed for a
  // .docx, an empty string when nothing is registered for the extension, and
  // application/octet-stream for anything dragged out of an archive. Refusing
  // on it rejected files this pipeline handles perfectly well.
  //
  // Nothing is lost by trusting it less. The extension is checked above, and
  // ingest sniffs the actual bytes and refuses a file whose contents do not
  // match what it claims to be — which is the check that was ever worth
  // anything, because it is the only one the uploader cannot choose.

  // The per-page and per-cell allowances are charged once the pipeline knows
  // the real size; the upload count is charged here, before any work starts.
  const quota = await checkQuota(input.quotaKey, "uploads")
  if (!quota.allowed) {
    return {
      ok: false,
      reason: "quota",
      status: 429,
      message: quotaMessage(quota),
      quota: { used: quota.used, limit: quota.limit },
    }
  }

  const documentId = newDocumentId()
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000)

  await prisma.document.create({
    data: {
      id: documentId,
      originalName: input.filename,
      // Both are provisional: ingest re-derives them from the actual bytes.
      kind,
      mimeType: input.contentType ?? "application/octet-stream",
      size: input.size,
      status: "uploading",
      preset: input.preset ?? null,
      userFingerprint: input.ownerKey,
      quotaKey: input.quotaKey,
      batchId: input.batchId ?? null,
      ttlSeconds: input.ttlSeconds,
      expiresAt,
    },
  })

  await recordUsage({
    fingerprint: input.quotaKey,
    kind: "uploads",
    quantity: 1,
  })

  return {
    ok: true,
    id: documentId,
    pathname: uploadKey(documentId, input.filename),
    expiresAt,
    quota: { used: quota.used + 1, limit: quota.limit },
  }
}
