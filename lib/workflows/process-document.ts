import {
  FatalError,
  getStepMetadata,
  getWritable,
  RetryableError,
} from "workflow"
import { start } from "workflow/api"

import { analyzeDocument, analyzeImageRegions } from "@/lib/ai/analyze"
import { skipIsFailure, type StructuredSkip } from "@/lib/ai/gateway"
import type { Prisma } from "@/lib/database/generated/client"
import { prisma } from "@/lib/database/prisma"
import { MAX_UPLOAD_BYTES } from "@/lib/config"
import { admitAfter } from "@/lib/documents/admission"
import { extractDelimited } from "@/lib/documents/delimited/extract"
import { extractDocx } from "@/lib/documents/docx/extract"
import { extractPdf } from "@/lib/documents/pdf/extract"
import { extractPptx } from "@/lib/documents/pptx/extract"
import { extractImage } from "@/lib/documents/image/extract"
import {
  MAX_VISION_PAGES,
  renderPagesForVision,
} from "@/lib/documents/pdf/page-images"
import { extractEml } from "@/lib/documents/eml/extract"
import { extractRtf } from "@/lib/documents/rtf/extract"
import { extractText } from "@/lib/documents/text/extract"
import { extractXlsx } from "@/lib/documents/xlsx/extract"
import { detectDocumentType, extensionMatchesKind } from "@/lib/documents/detect"
import { ExpansionLimitError } from "@/lib/documents/eml/attachments"
import { EmlLimitError } from "@/lib/documents/eml/limits"
import { MboxLimitError } from "@/lib/documents/mbox/limits"
import { MboxParseError } from "@/lib/documents/mbox/parse"
import { expandContainer } from "@/lib/documents/expand"
import { newEventId } from "@/lib/documents/ids"
import { saveNormalized } from "@/lib/documents/normalized-store"
import { loadNormalized } from "@/lib/documents/normalized-store"
import { detectionToRedaction, toDatabaseRow } from "@/lib/redaction/model"
import { categoryAllowed, presetById } from "@/lib/redaction/presets"
import { carryBatchRules } from "@/lib/redaction/rules"
import { chargeDocumentUsage, quotaMessage } from "@/lib/security/usage"
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

/**
 * Expansion: a container becomes a batch.
 *
 * Two kinds are containers, at two scales. A message with attachments is one
 * document plus its enclosures; a mailbox is nothing but documents — hundreds
 * of messages concatenated, which is the form email actually takes when
 * somebody exports an archive. Both become a batch, and the difference between
 * them is only who enumerates the children; see lib/documents/expand.ts.
 *
 * Here rather than at reservation because reservation runs before the browser
 * has uploaded anything — there are no bytes to parse and the declared MIME
 * type is a guess. And before extraction, so the children are already queued
 * while the container is still being read: a reviewer opening the batch sees
 * the messages arriving rather than appearing at the end.
 *
 * Every other kind falls straight through, and a message with nothing
 * expandable in it costs one parse.
 */
async function expandContainerStep(
  documentId: string
): Promise<{ children: number; container: boolean }> {
  "use step"
  return runExpandContainer(documentId).catch(paced)
}

// A parse, a handful of sealed writes and a run started per child. Storage and
// the database dominate, so a blip is weather; the verdicts below throw
// FatalError, which `paced` lets through untouched.
expandContainerStep.maxRetries = 4

async function runExpandContainer(
  documentId: string
): Promise<{ children: number; container: boolean }> {
  let summary
  try {
    summary = await expandContainer(documentId)
  } catch (error) {
    // A limit — the MIME parser's, attachment expansion's, or the mailbox's —
    // is a verdict about this file, not weather. Retrying reads the same bytes
    // and reaches the same number, and the reviewer deserves the reason rather
    // than four attempts and a shrug. Refused whole: a partly expanded
    // container would look complete.
    if (
      error instanceof EmlLimitError ||
      error instanceof ExpansionLimitError ||
      error instanceof MboxLimitError ||
      error instanceof MboxParseError
    ) {
      throw new FatalError(error.message)
    }
    throw error
  }

  if (summary.children.length === 0 && summary.carried === 0) {
    return { children: 0, container: summary.container }
  }

  // Each child is a first-class document from here on: its own run, its own
  // extraction, its own detectors, its own review, its own export. Nothing
  // downstream should be able to tell that it arrived inside a message or a
  // mailbox rather than off a desktop.
  for (const child of summary.children) {
    if (!child.processable) continue
    await startChildRun(child.id)
  }

  // A pure container says so at the end instead, in `finishContainer`, because
  // for a mailbox this *is* the run finishing rather than a stage of it.
  if (!summary.container) {
    await emit(documentId, "document.attachments.expanded", {
      status: "extracting",
      payload: {
        // Counts only. A filename here would be document content in an event
        // stream that is deliberately free of it.
        children: summary.children.length,
        carried: summary.carried,
        batchId: summary.batchId,
      },
    })
  }

  return { children: summary.children.length, container: summary.container }
}

/**
 * Starts a child's run, at most once.
 *
 * Guarded on the column rather than on the step replaying: this step is
 * retried, and a second run over the same document would race the first
 * through the same rows.
 */
async function startChildRun(documentId: string): Promise<void> {
  const record = await prisma.document.findUnique({
    where: { id: documentId },
    select: { workflowRunId: true },
  })
  if (record?.workflowRunId) return

  const run = await start(processDocument, [documentId])
  await prisma.document.update({
    where: { id: documentId },
    data: { workflowRunId: run.runId },
  })
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
      metadata: true,
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
  // charged. Going over stops the pipeline; it never deletes what was
  // uploaded. Charging is idempotent — see chargeDocumentUsage — because this
  // step is retried and re-extracts from scratch each time.
  const { quota } = await chargeDocumentUsage({
    documentId,
    kind: document.kind as DocumentKind,
    quotaKey: document.quotaKey,
    metadata: document.metadata,
    model,
  })

  if (quota && !quota.allowed) throw new FatalError(quotaMessage(quota))

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
    case "rtf": {
      const { document } = extractRtf(documentId, bytes)
      return document
    }
    case "eml": {
      const { document } = extractEml(documentId, bytes)
      return document
    }
    case "pptx": {
      const { document } = extractPptx(documentId, bytes)
      return document
    }
    // Unreachable: the orchestrator finishes a container before it gets here.
    // Named anyway, because "no extractor registered" would be read as a gap
    // in the register rather than as a pipeline that took a wrong turn.
    case "mbox":
      throw new FatalError("A mailbox is expanded rather than extracted")
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

  // The vision pass is driven here rather than inside `analyzeDocument`, so the
  // calls it loses have to be counted here too — a scanned signature block that
  // was never looked at is exactly the kind of miss this reporting exists for.
  let visionSkip: StructuredSkip | undefined
  let lostVisionCalls = 0

  const { detections, sensitiveColumns, degraded } = await analyzeDocument(
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
    const analysis = await analyzeImageRegions(documentId, model, {
      data: bytes,
      mediaType: document.mimeType,
    })
    lostVisionCalls += analysis.skipped ? 1 : 0
    visionSkip ??= analysis.skipped
    detections.push(
      ...analysis.regions.filter((detection) =>
        categoryAllowed(preset, detection.category)
      )
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
        const analysis = await analyzeImageRegions(
          documentId,
          model,
          { data: png, mediaType: "image/png" },
          page
        )
        lostVisionCalls += analysis.skipped ? 1 : 0
        visionSkip ??= analysis.skipped
        detections.push(
          ...analysis.regions.filter((detection) =>
            categoryAllowed(preset, detection.category)
          )
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

  // Say what the model was not able to do, before the suggestions are written.
  //
  // A run that comes out the far end looking finished, having quietly reviewed
  // the document against pattern matching alone, is the failure mode this whole
  // codebase exists to prevent. It arrives with a clean exit code, so the only
  // thing that surfaces it is saying so on purpose.
  const worstSkip =
    degraded?.reason ?? (skipIsFailure(visionSkip) ? visionSkip : undefined)
  const lostCalls = (degraded?.calls ?? 0) + lostVisionCalls

  if (worstSkip) {
    await emit(documentId, "document.ai.degraded", {
      status: "analyzing",
      payload: { reason: worstSkip, calls: lostCalls },
    })
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

/**
 * The end of the line for a container.
 *
 * A mailbox is not a document that was processed — it is the batch its
 * messages arrived in, and once they exist there is nothing left for it to do.
 * It is never normalized, never analyzed and never exported, so running it
 * through the remaining stages would mean an extractor that does not exist and
 * a review of nothing.
 *
 * `expanded` rather than `ready` or `failed`, because it is neither and saying
 * so matters in three places at once: the batch export skips it by name rather
 * than reporting a document that "had not finished processing", the editor
 * does not offer to open something with no model behind it, and the reviewer
 * is told what actually happened to the file they uploaded.
 */
async function finishContainer(
  documentId: string,
  children: number
): Promise<void> {
  "use step"

  await setStatus(documentId, "expanded", { error: null, errorCode: null })
  await emit(documentId, "document.expanded", {
    status: "expanded",
    progress: 100,
    // Counts only, as everywhere on this stream: a subject line or a sender
    // here would be document content in a record that is deliberately free of
    // it.
    payload: { children },
  })
  await getWritable().close()
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
/**
 * Lets the next of this owner's documents start.
 *
 * A step of its own, so it is recorded and not repeated on a replay, and so a
 * failure to admit cannot undo the run that just succeeded — `admitAfter`
 * swallows its own errors for that reason, and the cleanup sweep is what
 * catches whatever this misses.
 *
 * This is the piece that makes the processing limit a queue rather than a
 * throttle: without it, a document that arrived while the owner was at their
 * limit would sit at "queued" until they happened to upload something else.
 */
async function admitNext(documentId: string): Promise<void> {
  "use step"
  // Imported inside the step rather than at the top of the file: this module
  // is the workflow that module starts, and a top-level import would be a
  // cycle the compiler follows out of a workflow function.
  const { startProcessing } = await import("@/lib/workflows/start-processing")
  await admitAfter(documentId, startProcessing)
}

/**
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
    const expansion = await expandContainerStep(documentId)

    // A mailbox stops here. Its messages are already queued as documents of
    // their own, and the container itself has nothing to extract: it is the
    // batch, not a file in it.
    if (expansion.container) {
      await finishContainer(documentId, expansion.children)
      await admitNext(documentId)
      return { documentId, status: "expanded" }
    }

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
    // This document's slot is free; whatever was waiting behind it starts now.
    await admitNext(documentId)
    return { documentId, status: "ready" }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await fail(documentId, message)
    // A failure frees the slot exactly as a success does. Forgetting this is
    // how a queue drains only when everything goes right.
    await admitNext(documentId)
    return { documentId, status: "failed" }
  }
}
