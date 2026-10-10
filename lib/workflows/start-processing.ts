import { getRun, start } from "workflow/api"

import type { StartRun } from "@/lib/documents/admission"
import { processDocument } from "@/lib/workflows/process-document"
import type { CancelRun } from "@/lib/workflows/recovery"

/**
 * Starting one document's processing run.
 *
 * One line, and a module of its own, because of where it may be imported from.
 * `lib/documents/admission.ts` decides *whether* a document starts and is
 * reached from inside the processing workflow itself; if it also imported the
 * workflow, the compiler would follow that cycle out of a workflow function and
 * find a database client at the top of a module it now believed was part of
 * one. Splitting the decision from the act keeps the queue logic importable
 * from anywhere.
 */
export const startProcessing: StartRun = async (documentId) => {
  const run = await start(processDocument, [documentId])
  return run.runId
}

/** A run that has already ended needs no cancelling. */
const ENDED = new Set(["completed", "failed", "cancelled"])

/** Cancelling a lost run, for the recovery sweep (#182). */
export const cancelProcessing: CancelRun = async (runId) => {
  const run = getRun(runId)
  try {
    await run.cancel()
  } catch (error) {
    if (ENDED.has(await run.status.catch(() => ""))) return
    throw error
  }
}
