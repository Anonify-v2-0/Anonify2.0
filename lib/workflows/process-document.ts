import type { Prisma } from "@/lib/database/generated/client"
import { prisma } from "@/lib/database/prisma"
import { extractDocx } from "@/lib/documents/docx/extract"
import { extractPdf } from "@/lib/documents/pdf/extract"
import { newEventId } from "@/lib/documents/ids"
import { saveNormalized } from "@/lib/documents/normalized-store"
import { getObject } from "@/lib/storage/blob"
import { decryptDocument } from "@/lib/storage/encryption"
import { checksumMatches, sha256 } from "@/lib/storage/integrity"
import type { DocumentKind, NormalizedDocument } from "@/types/document"
import type { ProcessingEventType, ProcessingStatus } from "@/types/processing"

/**
 * Document processing pipeline.
 *
 * Each stage is separately retryable and records its own event, so a failure in
 * analysis never loses the uploaded file and the client can watch progress
 * arrive. Milestone 9 moves the driver onto Vercel Workflows; the stage
 * boundaries here are exactly what it will schedule.
 */

export async function recordEvent(
  documentId: string,
  type: ProcessingEventType,
  payload?: Record<string, unknown>
): Promise<void> {
  await prisma.processingEvent.create({
    data: {
      id: newEventId(),
      documentId,
      type,
      payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  })
}

export async function setStatus(
  documentId: string,
  status: ProcessingStatus,
  data: {
    pageCount?: number
    error?: string | null
    normalizedBlobKey?: string
  } = {}
): Promise<void> {
  await prisma.document.update({
    where: { id: documentId },
    data: { status, ...data },
  })
}

type ExtractionResult = {
  model: NormalizedDocument
  pageCount: number
  ocrPages: number[]
}

/** Reads the source back, verifies its checksum, and normalizes it. */
export async function extractDocument(
  document: {
    id: string
    kind: string
    sourceBlobKey: string
    encryptionKey: string
    checksum: string
  }
): Promise<ExtractionResult> {
  const sealed = await getObject(document.sourceBlobKey)
  const bytes = decryptDocument(sealed, document.encryptionKey)

  if (!checksumMatches(document.checksum, sha256(bytes))) {
    throw new Error("Source checksum mismatch")
  }

  switch (document.kind as DocumentKind) {
    case "pdf": {
      const { document: model, ocrPages } = await extractPdf(document.id, bytes)
      return { model, pageCount: model.pages.length, ocrPages }
    }
    case "docx": {
      const { document: model } = extractDocx(document.id, bytes)
      return { model, pageCount: model.pages.length, ocrPages: [] }
    }
    default:
      // XLSX and image pipelines attach in milestones 5-6.
      throw new Error(`No extractor registered for ${document.kind}`)
  }
}

export async function startProcessing(documentId: string): Promise<void> {
  const startedAt = Date.now()

  try {
    await recordEvent(documentId, "document.queued")

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        kind: true,
        sourceBlobKey: true,
        encryptionKey: true,
        checksum: true,
      },
    })
    if (!document) return

    await setStatus(documentId, "extracting")
    await recordEvent(documentId, "document.extracting")
    const { model, pageCount } = await extractDocument(document)

    await setStatus(documentId, "normalizing")
    await recordEvent(documentId, "document.normalizing")
    const normalizedBlobKey = await saveNormalized(
      documentId,
      document.encryptionKey,
      model
    )

    // Deterministic detection and AI analysis attach in milestones 7-8.

    await setStatus(documentId, "ready", {
      error: null,
      pageCount,
      normalizedBlobKey,
    })
    await recordEvent(documentId, "document.ready", {
      pageCount,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      JSON.stringify({
        level: "error",
        context: "process-document",
        documentId,
        durationMs: Date.now() - startedAt,
        errorCategory: "processing",
      })
    )
    // The source file is untouched; the user can retry analysis.
    await setStatus(documentId, "failed", {
      error: message.slice(0, 500),
    }).catch(() => undefined)
    await recordEvent(documentId, "document.failed").catch(() => undefined)
  }
}
