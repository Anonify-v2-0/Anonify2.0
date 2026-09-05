import {
  FatalError,
  getStepMetadata,
  getWritable,
  RetryableError,
} from "workflow"

import { analyzeDocument, analyzeImageRegions } from "@/lib/ai/analyze"
import type { Prisma } from "@/lib/database/generated/client"
import { prisma } from "@/lib/database/prisma"
import { MAX_UPLOAD_BYTES } from "@/lib/config"
import { extractDelimited } from "@/lib/documents/delimited/extract"
import { extractDocx } from "@/lib/documents/docx/extract"
import { extractPdf } from "@/lib/documents/pdf/extract"
import { extractImage } from "@/lib/documents/image/extract"
import {
  MAX_VISION_PAGES,
  renderPagesForVision,
} from "@/lib/documents/pdf/page-images"
import { extractText } from "@/lib/documents/text/extract"
import { extractXlsx } from "@/lib/documents/xlsx/extract"
import { detectDocumentType, extensionMatchesKind } from "@/lib/documents/detect"
import { newEventId } from "@/lib/documents/ids"
import { saveNormalized } from "@/lib/documents/normalized-store"
import { loadNormalized } from "@/lib/documents/normalized-store"
import { detectionToRedaction, toDatabaseRow } from "@/lib/redaction/model"
import { categoryAllowed, presetById } from "@/lib/redaction/presets"
import { carryBatchRules } from "@/lib/redaction/rules"
import {
  quotaMessage,
  recordUsage,
  usageKindFor,
  usageQuantity,
} from "@/lib/security/usage"
import { deleteObject, getObject, putObject, sourceKey } from "@/lib/storage/blob"
import { decryptDocument, encryptDocument } from "@/lib/storage/encryption"
import { checksumMatches, sha256 } from "@/lib/storage/integrity"
import {
  encodeStreamEvent,
  type ProcessingStreamEvent,
} from "@/lib/workflows/events"
import { describeFailure } from "@/lib/workflows/failure"
import type { DocumentKind } from "@/types/document"
import type {
  ProcessingEventType,
  ProcessingStatus,
} from "@/types/processing"

/**
 * Durable document processing.
 *
 * The orchestrator below only sequences steps; all real work lives in `"use
 * step"` functions, which have full Node access, are retried independently, and
 * have their results persisted. A step that fails — an extractor that chokes, a
 * provider that times out — never costs the user their upload, and the run
 * resumes from the last completed step rather than from the beginning.
 *
 * Every stage writes a small progress event to the run's stream so the
 * workspace can show suggestions arriving instead of a spinner.
 */

/**
 * How long to wait before a step's next attempt.
 *
 * The SDK retries a throwing step three times by default and enqueues each
 * attempt immediately, which is close to no retry at all against the failures
 * that are actually transient: a provider rate limit, a cold worker, a storage
 * blip. Three tries inside a few hundred milliseconds sees the same weather all
 * three times, and against a rate limit it makes things worse.
 *
 * Doubling from a second, capped so a stuck dependency cannot park a run for
 * half an hour.
 */
const MAX_BACKOFF_MS = 30_000

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempt - 1))
}

/**
 * Rethrows a step's error with a delay before the next attempt.
 *
 * `FatalError` passes through untouched — it exists to say retrying cannot
 * help, and wrapping it would throw that away. The original message is carried
 * across so the orchestrator can still classify the failure; it is never stored
 * or logged raw.
 */
function paced(error: unknown): never {
  if (FatalError.is(error)) throw error

  const message = error instanceof Error ? error.message : String(error)
  const { attempt } = getStepMetadata()

  throw new RetryableError(message, { retryAfter: backoffMs(attempt) })
}

async function emit(
  documentId: string,
  type: ProcessingEventType,
  extra: Omit<ProcessingStreamEvent, "type" | "documentId" | "at"> = {}
): Promise<void> {
  const event: ProcessingStreamEvent = {
    type,
    documentId,
    at: new Date().toISOString(),
    ...extra,
  }

  const writer = getWritable<string>().getWriter()
  try {
    await writer.write(encodeStreamEvent(event))
  } finally {
    // An unreleased lock keeps the step's request alive until it times out.
    writer.releaseLock()
  }

  await prisma.processingEvent.create({
    data: {
      id: newEventId(),
      documentId,
      type,
      payload: (extra.payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  })
}

async function setStatus(
  documentId: string,
  status: ProcessingStatus,
  data: {
    pageCount?: number
    error?: string | null
    errorCode?: string | null
    normalizedBlobKey?: string
  } = {}
): Promise<void> {
  await prisma.document.update({
    where: { id: documentId },
    data: { status, ...data },
  })
}

/**
 * Ingest.
 *
 * The browser uploads straight to Blob storage, so the first thing the pipeline
 * does is take ownership of those bytes: sniff what they actually are, checksum
 * them, seal them under a fresh per-document key, and delete the plaintext
 * upload. That window is the only time the file exists unencrypted at rest.
 */
async function ingestUpload(documentId: string): Promise<{ kind: DocumentKind }> {
  "use step"
  return runIngest(documentId).catch(paced)
}

// Storage reads, a write back and the plaintext delete all live in here, so a
// failure is usually weather rather than a verdict. The verdicts throw
// FatalError, which `paced` lets through untouched.
ingestUpload.maxRetries = 4

async function runIngest(documentId: string): Promise<{ kind: DocumentKind }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      originalName: true,
      uploadBlobKey: true,
      sourceBlobKey: true,
      kind: true,
    },
  })

  if (!document) throw new FatalError("Document no longer exists")

  // Already ingested: the step is replaying after a retry.
  if (document.sourceBlobKey) {
    return { kind: document.kind as DocumentKind }
  }
  if (!document.uploadBlobKey) {
    throw new FatalError("No upload to ingest")
  }

  const bytes = await getObject(document.uploadBlobKey)

  if (bytes.byteLength === 0) throw new FatalError("Uploaded file is empty")
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new FatalError("Uploaded file is too large")
  }

  // The filename is passed as a hint, not as an authority: it can only choose
  // between text formats whose bytes already decode as text.
  const detected = detectDocumentType(bytes, document.originalName)
  if (!detected) throw new FatalError("Unsupported file type")
  if (!extensionMatchesKind(document.originalName, detected.kind)) {
    throw new FatalError("File contents do not match its extension")
  }

  const checksum = sha256(bytes)
  const { ciphertext, wrappedKey } = encryptDocument(bytes)
  const stored = await putObject(sourceKey(documentId), ciphertext)

  await prisma.document.update({
    where: { id: documentId },
    data: {
      sourceBlobKey: stored.key,
      encryptionKey: wrappedKey,
      checksum,
      size: bytes.byteLength,
      kind: detected.kind,
      mimeType: detected.mimeType,
    },
  })

  await deleteObject(document.uploadBlobKey)
  await prisma.document.update({
    where: { id: documentId },
    data: { uploadBlobKey: null },
  })

  return { kind: detected.kind }
}

/** Reads the sealed source back, verifies its checksum and normalizes it. */
async function extractAndNormalize(
  documentId: string
): Promise<{ pageCount: number }> {
  "use step"
  return runExtractAndNormalize(documentId).catch(paced)
}

// The most expensive step to lose: it re-reads the sealed source, runs the
// format pipeline and may run OCR over every page. Worth waiting out a blip
// rather than failing the document and making the user ask for it again.
extractAndNormalize.maxRetries = 4

async function runExtractAndNormalize(
  documentId: string
): Promise<{ pageCount: number }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      kind: true,
      sourceBlobKey: true,
      encryptionKey: true,
      checksum: true,
      quotaKey: true,
    },
  })

  if (!document?.sourceBlobKey || !document.encryptionKey || !document.checksum) {
    throw new FatalError("Document has not been ingested")
  }

  const sealed = await getObject(document.sourceBlobKey)
  const bytes = decryptDocument(sealed, document.encryptionKey)

  if (!checksumMatches(document.checksum, sha256(bytes))) {
    throw new FatalError("Source checksum mismatch")
  }

  const model = await extractByKind(document.id, document.kind as DocumentKind, bytes)
  const normalizedBlobKey = await saveNormalized(
    documentId,
    document.encryptionKey,
    model
  )

  await prisma.document.update({
    where: { id: documentId },
    data: { normalizedBlobKey, pageCount: model.pages.length },
  })

  // The real cost is only knowable now, so this is where the demo allowance is
  // charged. Going over stops the pipeline; it never deletes what was uploaded.
  if (document.quotaKey) {
    const kind = usageKindFor(document.kind as DocumentKind)
    const quantity = usageQuantity(kind, model)

    const quota = await recordUsage({
      fingerprint: document.quotaKey,
      kind,
      quantity,
    })
    if (!quota.allowed) throw new FatalError(quotaMessage(quota))
  }

  return { pageCount: model.pages.length }
}

async function extractByKind(
  documentId: string,
  kind: DocumentKind,
  bytes: Uint8Array
) {
  switch (kind) {
    case "pdf": {
      // Scanned pages are read here rather than arriving empty with no
      // explanation; see lib/documents/pdf/ocr.ts.
      const { document } = await extractPdf(documentId, bytes, { ocr: true })
      return document
    }
    case "docx": {
      const { document } = extractDocx(documentId, bytes)
      return document
    }
    case "xlsx": {
      const { document } = await extractXlsx(documentId, bytes)
      return document
    }
    case "image": {
      const { document } = await extractImage(documentId, bytes)
      return document
    }
    case "csv":
    case "tsv": {
      const { document } = extractDelimited(documentId, kind, bytes)
      return document
    }
    case "txt": {
      const { document } = extractText(documentId, bytes)
      return document
    }
    default:
      throw new FatalError(`No extractor registered for ${kind}`)
  }
}

/**
 * Analysis.
 *
 * Deterministic detectors run first and the model only answers what they cannot
 * — see lib/ai/analyze.ts. Everything produced here is persisted as a
 * *suggestion*: the pipeline never marks its own findings accepted.
 */
async function analyze(documentId: string): Promise<{ suggestions: number }> {
  "use step"
  return runAnalyze(documentId).catch(paced)
}

// Provider errors never reach this: `runStructured` catches them and returns
// null, because detection is an assist and losing it must not cost the user
// their document. What retries here is everything around it — storage, the
// database, rasterizing pages for the vision pass.
analyze.maxRetries = 4

async function runAnalyze(documentId: string): Promise<{ suggestions: number }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      kind: true,
      mimeType: true,
      encryptionKey: true,
      normalizedBlobKey: true,
      sourceBlobKey: true,
      preset: true,
    },
  })

  if (!document?.normalizedBlobKey || !document.encryptionKey) {
    throw new FatalError("Document has not been normalized")
  }

  const model = await loadNormalized(
    document.normalizedBlobKey,
    document.encryptionKey
  )

  // Null when no preset was chosen, which means everything is looked for.
  const preset = presetById(document.preset)

  const { detections, sensitiveColumns } = await analyzeDocument(
    documentId,
    model,
    async (update) => {
      await emit(documentId, "document.ai.progress", {
        status: "analyzing",
        payload: {
          stage: update.stage,
          completed: update.completed,
          total: update.total,
          suggestions: update.detections,
        },
      })
    },
    preset
  )

  // Pixels get a vision pass, because no amount of text analysis can see a
  // face, a signature or a photographed ID card.
  if (document.sourceBlobKey && document.kind === "image") {
    const sealed = await getObject(document.sourceBlobKey)
    const bytes = decryptDocument(sealed, document.encryptionKey)
    detections.push(
      ...(
        await analyzeImageRegions(documentId, model, {
          data: bytes,
          mediaType: document.mimeType,
        })
      ).filter((detection) => categoryAllowed(preset, detection.category))
    )
  }

  // The same pass for a PDF, over the pages that actually paint something.
  // Those pages were being extracted for their text and then never looked at,
  // so a scanned signature block or a photograph inside an otherwise ordinary
  // document produced no suggestion at all — the one failure mode this tool
  // exists to prevent, arriving silently.
  if (document.sourceBlobKey && document.kind === "pdf") {
    const imagePages = model.pages
      .filter((page) => page.images)
      .map((page) => page.number)
      .slice(0, MAX_VISION_PAGES)

    if (imagePages.length > 0) {
      const sealed = await getObject(document.sourceBlobKey)
      const bytes = decryptDocument(sealed, document.encryptionKey)
      const rendered = await renderPagesForVision(bytes, imagePages)

      for (const [index, { page, png }] of rendered.entries()) {
        detections.push(
          ...(
            await analyzeImageRegions(
              documentId,
              model,
              { data: png, mediaType: "image/png" },
              page
            )
          ).filter((detection) => categoryAllowed(preset, detection.category))
        )
        await emit(documentId, "document.ai.progress", {
          status: "analyzing",
          payload: {
            stage: "image",
            completed: index + 1,
            total: rendered.length,
            suggestions: detections.length,
          },
        })
      }
    }
  }

  const redactions = detections.map((detection) =>
    detectionToRedaction(documentId, detection)
  )

  // A sensitive column is proposed as one column-level redaction rather than
  // one per cell: that is the decision the reviewer wants to make.
  for (const column of sensitiveColumns) {
    redactions.push({
      id: detectionToRedaction(documentId, {
        text: column.header,
        category: column.category,
        confidence: column.confidence,
      }).id,
      documentId,
      type: "column",
      source: "ai",
      category: column.category,
      confidence: column.confidence,
      status: "suggested",
      text: column.header,
      worksheet: column.worksheet,
      column: column.column,
      reason: column.reason,
      metadata: {
        filledRows: column.filledRows,
        totalRows: column.totalRows,
      },
    })
  }

  if (redactions.length > 0) {
    await prisma.redaction.createMany({
      data: redactions.map((redaction) => toDatabaseRow(redaction)),
    })
  }

  await emit(documentId, "document.redaction.created", {
    status: "analyzing",
    payload: { suggestions: redactions.length },
  })

  return { suggestions: redactions.length }
}

/**
 * Applies the decisions the batch has already made.
 *
 * A batch is reviewed while its documents are still arriving, so a rule agreed
 * on the first file has to reach the fourth one — which was still being
 * analyzed when the reviewer agreed it. This is where that happens, after
 * analysis so the rule's redactions sit alongside the suggestions.
 *
 * It is allowed to fail the document rather than being swallowed. A carried
 * decision that quietly did not arrive is a value the reviewer believes they
 * have already removed everywhere, which is the one kind of silence this tool
 * cannot afford. Retrying is safe: rules already applied here are skipped.
 */
async function carryDecisions(
  documentId: string
): Promise<{ rulesApplied: number; redactions: number }> {
  "use step"
  return carryBatchRules(documentId).catch(paced)
}

async function publishStatus(
  documentId: string,
  status: ProcessingStatus,
  type: ProcessingEventType,
  extra: Omit<ProcessingStreamEvent, "type" | "documentId" | "at"> = {}
): Promise<void> {
  "use step"

  await setStatus(documentId, status)
  await emit(documentId, type, { status, ...extra })
}

async function finish(
  documentId: string,
  pageCount: number,
  suggestions: number
): Promise<void> {
  "use step"

  await setStatus(documentId, "ready", {
    error: null,
    errorCode: null,
    pageCount,
  })
  await emit(documentId, "document.ready", {
    status: "ready",
    progress: 100,
    payload: { pageCount, suggestions },
  })
  await getWritable().close()
}

/**
 * Records a failure in the terms the user needs, not the terms it arrived in.
 *
 * The raw message is classified here and then dropped. Storing it was how
 * `FatalError: Unsupported file type` reached the screen, and any error at all
 * could take that path — a driver or parser message is not guaranteed to be
 * free of document content, which invariant 6 does not allow us to keep.
 *
 * Classification happens in the step rather than the orchestrator so the
 * workflow function stays pure sequencing.
 */
async function fail(documentId: string, rawMessage: string): Promise<void> {
  "use step"

  const failure = describeFailure(rawMessage)

  console.error(
    JSON.stringify({
      level: "error",
      context: "process-document",
      documentId,
      errorCategory: failure.code,
      retryable: failure.retryable,
    })
  )

  // The uploaded file is untouched either way; whether asking again can help is
  // what the code carries.
  await setStatus(documentId, "failed", {
    error: failure.message,
    errorCode: failure.code,
  })
  await emit(documentId, "document.failed", {
    status: "failed",
    message: failure.message,
    payload: { code: failure.code, retryable: failure.retryable },
  })
  await getWritable().close()
}

export async function processDocument(documentId: string): Promise<{
  documentId: string
  status: ProcessingStatus
}> {
  "use workflow"

  try {
    await publishStatus(documentId, "queued", "document.queued", { progress: 10 })

    await publishStatus(documentId, "extracting", "document.extracting", {
      progress: 30,
    })
    await ingestUpload(documentId)

    await publishStatus(documentId, "normalizing", "document.normalizing", {
      progress: 55,
    })
    const { pageCount } = await extractAndNormalize(documentId)

    await publishStatus(documentId, "analyzing", "document.ai.started", {
      progress: 70,
    })
    const { suggestions } = await analyze(documentId)

    await carryDecisions(documentId)

    await finish(documentId, pageCount, suggestions)
    return { documentId, status: "ready" }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await fail(documentId, message)
    return { documentId, status: "failed" }
  }
}
