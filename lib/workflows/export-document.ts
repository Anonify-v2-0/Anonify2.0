import {
  FatalError,
  getStepMetadata,
  getWritable,
  RetryableError,
} from "workflow"

import type { Prisma } from "@/lib/database/generated/client"
import { prisma } from "@/lib/database/prisma"
import {
  artifactIdFor,
  type DocumentExportProgress,
  type DocumentExportStatus,
} from "@/lib/documents/document-exports"
import { exportAndStore } from "@/lib/redaction/deliver"
import { ExportVerificationError } from "@/lib/redaction/export"
import { ReportLeakError } from "@/lib/redaction/report"
import type { ExportVariant } from "@/lib/redaction/variants"
import {
  encodeDocumentExportEvent,
  type DocumentExportStreamEvent,
} from "@/lib/workflows/document-export-events"

/**
 * One document's export, as a durable run on the workers (#187).
 *
 * It used to run inside the HTTP request: every redacted PDF page
 * rasterised, the document rebuilt, re-opened for verification, sealed and
 * stored, all on the web tier and within the request's time limit. A few at
 * once starved the interface, and a replica recycled mid-request lost the
 * export. Now each variant is a step, run on a worker inside a CPU slot
 * (#181), retried on its own and resumed after a lost worker, reporting its
 * stage and pages as it goes. The work is still `exportAndStore`, the one
 * definition of an export and its verification gate.
 *
 * Nothing a step returns carries the vault: a step's result is persisted in
 * the run's event log, and the vault is sealed to the requesting browser and
 * stored only as that envelope (lib/redaction/vault-envelope.ts).
 */

const MAX_BACKOFF_MS = 30_000

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempt - 1))
}

/** Same pacing as the other runs; see lib/workflows/process-document.ts. */
function paced(error: unknown): never {
  if (FatalError.is(error)) throw error
  const message = error instanceof Error ? error.message : String(error)
  const { attempt } = getStepMetadata()
  throw new RetryableError(message, { retryAfter: backoffMs(attempt) })
}

/** The refusals a reviewer is told about, by what they are; never the text. */
const VERIFICATION_FAILED =
  "The generated document did not pass verification and was not saved."
const REPORT_FAILED =
  "The export report did not pass verification and was not saved."
const NOT_READY = "This document is not ready to export."
const UNEXPECTED = "The export could not be completed."

async function report(
  status: DocumentExportStatus,
  progress: DocumentExportProgress | null,
  extra: {
    type?: DocumentExportStreamEvent["type"]
    error?: string | null
  } = {}
): Promise<void> {
  const event: DocumentExportStreamEvent = {
    type: extra.type ?? "export.progress",
    at: new Date().toISOString(),
    status,
    progress,
    error: extra.error ?? null,
  }
  const writer = getWritable<string>().getWriter()
  try {
    await writer.write(encodeDocumentExportEvent(event))
  } finally {
    // An unreleased lock keeps the step's request alive until it times out.
    writer.releaseLock()
  }
}

/** How many variants, and the run marked running. */
async function startDocumentExport(
  exportId: string
): Promise<{ variants: number; cancelled: boolean }> {
  "use step"
  return runStart(exportId).catch(paced)
}

async function runStart(
  exportId: string
): Promise<{ variants: number; cancelled: boolean }> {
  const record = await prisma.documentExport.findUnique({
    where: { id: exportId },
    select: { variants: true, cancelRequested: true, status: true },
  })
  if (!record) throw new FatalError("This export no longer exists")
  if (record.cancelRequested || record.status === "cancelled") {
    return { variants: 0, cancelled: true }
  }
  const variants = (record.variants as ExportVariant[]).length
  await prisma.documentExport.updateMany({
    where: { id: exportId, status: "queued" },
    data: { status: "running" },
  })
  await report("running", null)
  return { variants, cancelled: false }
}

type VariantOutcome = { stop: boolean }

/**
 * One variant: built, verified, sealed, stored. Idempotent: its artifact's
 * id is fixed by the export and the variant's place, so running it again
 * writes over what the first attempt wrote.
 */
async function exportVariantStep(
  exportId: string,
  index: number
): Promise<VariantOutcome> {
  "use step"
  return runVariant(exportId, index).catch(paced)
}

exportVariantStep.maxRetries = 4

async function runVariant(
  exportId: string,
  index: number
): Promise<VariantOutcome> {
  const record = await prisma.documentExport.findUnique({
    where: { id: exportId },
    select: {
      documentId: true,
      variants: true,
      recipientKey: true,
      cancelRequested: true,
      status: true,
    },
  })
  if (!record) throw new FatalError("This export no longer exists")
  if (record.cancelRequested || record.status === "cancelled") {
    return { stop: true }
  }

  const variants = record.variants as ExportVariant[]
  const variant = variants[index]
  if (!variant) throw new FatalError("This export has no such variant")

  // Progress goes to the stream as it happens, and to the row now and then,
  // in order: a write is queued behind the one before it.
  let writes: Promise<void> = Promise.resolve()
  let lastSaved = 0
  const onProgress = (update: {
    stage: DocumentExportProgress["stage"]
    done?: number
    total?: number
  }) => {
    const progress: DocumentExportProgress = {
      ...update,
      variant: variant.name,
      variantIndex: index,
      variants: variants.length,
    }
    const save = Date.now() - lastSaved > 1000 || update.stage !== "render"
    if (save) lastSaved = Date.now()
    writes = writes.then(async () => {
      if (save) {
        await prisma.documentExport.update({
          where: { id: exportId },
          data: { progress: progress as unknown as Prisma.InputJsonValue },
        })
      }
      await report("running", progress)
    })
  }

  try {
    const outcome = await exportAndStore(record.documentId, [variant], {
      recipientKey: record.recipientKey ?? undefined,
      exportId,
      artifactIds: [artifactIdFor(exportId, index)],
      // The document's pointer names the first variant, as before.
      updatePointer: index === 0,
      onProgress,
    })
    await writes
    if (!outcome.ok) throw new FatalError(NOT_READY)
    return { stop: false }
  } catch (error) {
    await writes.catch(() => undefined)
    if (error instanceof ExportVerificationError) {
      console.error(
        JSON.stringify({
          level: "error",
          context: "documents.export",
          exportId,
          errorCategory: "verification-failed",
          leakedCount: error.report.leaked.length,
        })
      )
      throw new FatalError(VERIFICATION_FAILED)
    }
    if (error instanceof ReportLeakError) {
      console.error(
        JSON.stringify({
          level: "error",
          context: "documents.export",
          exportId,
          errorCategory: "report-leak",
          fields: error.fields,
        })
      )
      throw new FatalError(REPORT_FAILED)
    }
    throw error
  }
}

async function finishDocumentExport(exportId: string): Promise<void> {
  "use step"

  const record = await prisma.documentExport.findUnique({
    where: { id: exportId },
    select: { cancelRequested: true, documentId: true },
  })
  if (!record) return
  const status: DocumentExportStatus = record.cancelRequested
    ? "cancelled"
    : "ready"
  // A cancel that landed while the last variant ran has already written
  // "cancelled"; finishing afterwards must not un-cancel it.
  await prisma.documentExport.updateMany({
    where: { id: exportId, status: { in: ["queued", "running"] } },
    data: { status },
  })
  console.log(
    JSON.stringify({
      level: "info",
      context: "documents.export",
      documentId: record.documentId,
      exportId,
      status,
    })
  )
  await report(status, null, { type: "export.finished" })
  await getWritable().close()
}

/**
 * The failure, in the terms the reviewer needs: one of the sentences above,
 * never the raw message, which is not guaranteed to be free of the document.
 */
async function failDocumentExport(
  exportId: string,
  raw: string
): Promise<void> {
  "use step"

  const known = [VERIFICATION_FAILED, REPORT_FAILED, NOT_READY].find((text) =>
    raw.includes(text)
  )
  const error = known ?? UNEXPECTED
  if (!known) {
    console.error(
      JSON.stringify({
        level: "error",
        context: "documents.export",
        exportId,
        errorCategory: "unexpected",
      })
    )
  }
  await prisma.documentExport.updateMany({
    where: { id: exportId, status: { in: ["queued", "running"] } },
    data: { status: "failed", error },
  })
  await report("failed", null, { type: "export.finished", error })
  await getWritable().close()
}

export async function exportSingleDocument(exportId: string): Promise<{
  exportId: string
  status: DocumentExportStatus
}> {
  "use workflow"

  try {
    const plan = await startDocumentExport(exportId)
    if (!plan.cancelled) {
      for (let index = 0; index < plan.variants; index++) {
        const outcome = await exportVariantStep(exportId, index)
        if (outcome.stop) break
      }
    }
    await finishDocumentExport(exportId)
    return { exportId, status: "ready" }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failDocumentExport(exportId, message)
    return { exportId, status: "failed" }
  }
}
